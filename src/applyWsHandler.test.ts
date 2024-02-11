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
import { z } from "zod";

import { type CreateWSSContextFnOptions, applyWSHandler } from "./index.js";

const testPort = 8798;

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
	});
	return router;
}

export type AppRouter = ReturnType<typeof makeRouter>;

function makeContext() {
	const createContext = ({ req, res }: CreateWSSContextFnOptions) => {
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

	const router = makeRouter();
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
