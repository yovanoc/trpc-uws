import {
	TRPCClientError,
	TRPCLink,
	createTRPCClient,
	createWSClient,
	httpBatchLink,
	splitLink,
	// unstable_httpBatchStreamLink,
	wsLink,
} from "@trpc/client";
import { TRPCError, initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import EventEmitter from "events";
import uWs from "uWebSockets.js";
import { WebSocket } from "unws";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import z from "zod";

import { applyWSHandler, createUWebSocketsHandler } from "./index.js";
import { CreateContextOptions } from "./types.js";

const testPort = 8799;

interface Message {
	id: string;
}

// TODO test middleware?
const ee = new EventEmitter();
function makeRouter() {
	const onNewMessageSubscription = vi.fn();
	const onSubscriptionEnded = vi.fn();

	const t = initTRPC.context<Context>().create();

	const router = t.router({
		error: t.procedure.query(() => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "error as expected",
			});
		}),
		hello: t.procedure
			.input(
				z
					.object({
						who: z.string().nullish(),
					})
					.nullish(),
			)
			.query(({ ctx, input }) => {
				return {
					text: `hello ${input?.who ?? ctx.user?.name ?? "world"}`,
				};
			}),
		manualRes: t.procedure.query(({ ctx }) => {
			ctx.res.writeStatus("400");
			ctx.res.writeHeader("manual", "header");
			ctx.res.writeHeader("set-cookie", "lala=true");
			ctx.res.writeHeader("set-cookie", "another-one=false");
			// ctx.res.
			return "status 400";
		}),
		onMessage: t.procedure.input(z.string()).subscription(() => {
			const sub = observable<Message>((emit) => {
				const onMessage = (data: Message) => {
					emit.next(data);
				};

				ee.on("server:msg", onMessage);
				return () => {
					onSubscriptionEnded();
					ee.off("server:msg", onMessage);
				};
			});
			ee.emit("subscription:created");

			onNewMessageSubscription();
			return sub;
		}),
		test: t.procedure
			.input(
				z.object({
					value: z.string(),
				}),
			)
			.mutation(({ ctx, input }) => {
				return {
					originalValue: input.value,
					user: ctx.user,
				};
			}),
	});
	return router;
}

export type AppRouter = ReturnType<typeof makeRouter>;

function makeContext() {
	const createContext = ({ req, res }: CreateContextOptions) => {
		const getUser = () => {
			if (req.headers.authorization === "meow") {
				return {
					name: "KATT",
				};
			}

			if (req.query.get("fail")) {
				throw new Error("context failed as expected");
			}

			return null;
		};

		return {
			req,
			res,
			// uWs,
			user: getUser(),
		};
	};

	return createContext;
}

export type Context = Awaited<ReturnType<typeof makeContext>>;

async function startServer() {
	const app = uWs.App();

	app.options("/*", (res) => {
		res.cork(() => {
			res.writeHeader("Access-Control-Allow-Origin", "*");

			res.endWithoutBody();
		});
	});

	const router = makeRouter();
	createUWebSocketsHandler(app, "/trpc", {
		createContext: makeContext(),
		maxBodySize: 10000,

		responseMeta() {
			return {
				headers: {
					"Access-Control-Allow-Origin": "*",
				},
			};
		},
		router,
		// enableSubscriptions: true,
	});

	applyWSHandler("/trpc", {
		app,
		createContext: ({ req, res }) => {
			const userName = req.query.get("user");

			const fail = req.query.get("fail");

			if (fail) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "failing as expected",
				});
			}

			return {
				req,
				res,
				user: userName
					? {
							name: userName,
						}
					: null,
			};
		},
		router,
	});

	let { socket } = await new Promise<{
		socket: false | uWs.us_listen_socket;
	}>((resolve) => {
		app.listen("0.0.0.0", testPort, (socket) => {
			resolve({
				socket,
			});
		});
	});

	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				try {
					uWs.us_listen_socket_close(socket);
					socket = false;
					resolve();
				} catch (error) {
					reject(
						new Error("failed to close server", {
							cause: error,
						}),
					);
				}
			}),
	};
}

function makeClient(headers: Record<string, string>) {
	const host = `localhost:${testPort}/trpc`;

	const client = createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				AbortController,
				fetch,
				headers,
				url: `http://${host}`,
			}),
		],
	});
	return {
		client,
	};
}

function makeClientWithWs(headers: Record<string, string>) {
	const host = `localhost:${testPort}/trpc`;
	const wsClient = createWSClient({
		WebSocket,
		retryDelayMs: (i) => {
			console.log("retrying connection in ws", i);
			return 200;
		},
		url: `ws://${host}`,
	});
	const client = createTRPCClient<AppRouter>({
		links: [
			linkSpy,
			splitLink({
				condition(op) {
					return op.type === "subscription";
				},
				false: httpBatchLink({
					AbortController,
					fetch,
					headers,
					url: `http://${host}`,
				}),
				true: wsLink({ client: wsClient }),
				// false: unstable_httpBatchStreamLink({
				//   url: `http://${host}`,
				//   headers: headers,
				//   AbortController,
				//   fetch,
				// }),
			}),
		],
	});
	return {
		client,
		closeWs: () => {
			return new Promise<void>((resolve) => {
				wsClient.connection?.ws?.addEventListener("close", () => {
					resolve();
				});
				wsClient.close();
			});
		},
	};
}

let t!: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
	t = await startServer();
});

afterEach(async () => {
	await t.close();
	ee.removeAllListeners();
});

const orderedResults: number[] = [];

const linkSpy: TRPCLink<AppRouter> = () => {
	// here we just got initialized in the app - this happens once per app
	// useful for storing cache for instance
	return ({ next, op }) => {
		// this is when passing the result to the next link
		// each link needs to return an observable which propagates results
		return observable((observer) => {
			const unsubscribe = next(op).subscribe({
				error: observer.error,
				next(value) {
					if (typeof value.result === "object") {
						if (
							"data" in value.result &&
							typeof value.result.data === "number"
						) {
							orderedResults.push(value.result.data);
						}
					}

					observer.next(value);
				},
			});
			return unsubscribe;
		});
	};
};

test("query simple success and error handling", async () => {
	// t.client.runtime.headers = ()
	const { client } = makeClient({});

	// client.
	expect(
		await client.hello.query({
			who: "test",
		}),
	).toMatchInlineSnapshot(`
    {
      "text": "hello test",
    }
  `);

	await expect(client.error.query()).rejects.toThrowError("error as expected");
});

test("mutation and reading headers", async () => {
	const { client } = makeClient({
		authorization: "meow",
	});

	expect(
		await client.test.mutate({
			value: "lala",
		}),
	).toMatchInlineSnapshot(`
    {
      "originalValue": "lala",
      "user": {
        "name": "KATT",
      },
    }
  `);
});

test("manually sets status and headers", async () => {
	const fetcher = await fetch(
		`http://localhost:${testPort}/trpc/manualRes?input=${encodeURI("{}")}`,
	);
	const body = (await fetcher.json()) as { result: { data: string } };
	expect(fetcher.status).toEqual(400);
	expect(body.result.data).toEqual("status 400");

	expect(fetcher.headers.get("Access-Control-Allow-Origin")).toEqual("*"); // from the meta
	expect(fetcher.headers.get("manual")).toEqual("header"); //from the result
});

// this needs to be tested
test("aborting requests works", async () => {
	const ac = new AbortController();
	const { client } = makeClient({});

	expect.assertions(1);

	setTimeout(() => {
		ac.abort();
	});

	try {
		await client.test.mutate(
			{
				value: "test",
			},
			{
				signal: ac.signal,
			},
		);
	} catch (error) {
		if (typeof error === "object" && error !== null && "name" in error) {
			expect(error.name).toBe("TRPCClientError");
		}
	}
});

// FIXME no idea how to make it non-flaky
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Source: https://github.com/trpc/trpc/blob/main/packages/tests/server/adapters/fastify.test.ts
test(
	"ugly subscription tests",
	async () => {
		ee.once("subscription:created", () => {
			setTimeout(() => {
				ee.emit("server:msg", {
					id: "1",
				});
				ee.emit("server:msg", {
					id: "2",
				});
			});
		});

		const { client, closeWs } = makeClientWithWs({});

		const onStartedMock = vi.fn();
		const onDataMock = vi.fn();
		const sub = client.onMessage.subscribe("onMessage", {
			onData(data) {
				expectTypeOf(data).not.toBeAny();
				expectTypeOf(data).toMatchTypeOf<Message>();
				onDataMock(data);
			},
			onStarted: onStartedMock,
		});

		// onStartedMock.

		// expect(onStartedMock).toh

		await sleep(300); // FIXME how to use waitFor instead?
		expect(onStartedMock).toHaveBeenCalledTimes(1);
		expect(onDataMock).toHaveBeenCalledTimes(2);
		// await waitFor(() => {
		//   expect(onStartedMock).toHaveBeenCalledTimes(1);
		//   expect(onDataMock).toHaveBeenCalledTimes(2);
		// });

		ee.emit("server:msg", {
			id: "3",
		});
		await sleep(500);
		expect(onDataMock).toHaveBeenCalledTimes(3);

		// await waitFor(() => {
		//   expect(onDataMock).toHaveBeenCalledTimes(3);
		// });

		expect(onDataMock.mock.calls).toMatchInlineSnapshot(`
    [
      [
        {
          "id": "1",
        },
      ],
      [
        {
          "id": "2",
        },
      ],
      [
        {
          "id": "3",
        },
      ],
    ]
  `);

		sub.unsubscribe();

		await sleep(500);

		expect(ee.listenerCount("server:msg")).toBe(0);
		expect(ee.listenerCount("server:error")).toBe(0);

		await closeWs();
	},
	{
		timeout: 10000,
	},
);

test.skip(
	"subscription failed context",
	async () => {
		expect.assertions(2);
		// const host = `localhost:${testPort}/trpc?user=user1`; // weClient can inject values via query string
		const host = `localhost:${testPort}/trpc?user=user1&fail=yes`; // weClient can inject values via query string
		const wsClient = createWSClient({
			WebSocket,
			retryDelayMs: (i) => {
				console.log("retrying connection in subscription only", i);
				return 200;
			},
			url: `ws://${host}`,
		});

		const client = createTRPCClient<AppRouter>({
			links: [wsLink({ client: wsClient })],
		});

		client.onMessage.subscribe("lala", {
			onError(err) {
				// expect this error here?
				expect(err).toBeInstanceOf(TRPCClientError);
				expect(err.message).toBe("failing as expected");
			},
		});

		await sleep(100);
		wsClient.close();
	},
	{
		timeout: 3000,
	},
);

test("options still passthrough (cors)", async () => {
	const res = await fetch(
		`http://localhost:${testPort}/trpc/hello?input=${encodeURI("{}")}`,
		{
			method: "OPTIONS",
		},
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});

test("large request body handling", async () => {
	const { client } = makeClient({});
	expect.assertions(2);

	try {
		await client.test.mutate({
			value: "0".repeat(2000000),
		});
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"name" in error &&
			"data" in error &&
			error.data &&
			typeof error.data === "object" &&
			"code" in error.data
		) {
			expect(error.name).toBe("TRPCClientError");
			expect(error.data.code).toBe("PAYLOAD_TOO_LARGE");
		}
	}
});
