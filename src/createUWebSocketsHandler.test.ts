import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import EventEmitter from "events";
// eslint-disable-next-line n/no-missing-import
import uWs from "uWebSockets.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { z } from "zod";

import {
	type CreateContextOptions,
	createUWebSocketsHandler,
} from "./index.js";

const testPort = 8799;

// TODO test middleware?
const ee = new EventEmitter();
function makeRouter() {
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

	const router = makeRouter();
	createUWebSocketsHandler(app, "/trpc", {
		cors: {
			origin: "*",
		},
		createContext: ({ req, res }) => {
			const getUser = () => {
				if (req.headers.authorization === "meow") {
					return {
						name: "KATT",
					};
				}

				res.writeHeader("x-user", "toto");

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
		},
		maxBodySize: 10000,

		responseMeta() {
			return {
				headers: {
					"test-header-meta": "test",
				},
			};
		},
		router,
		// enableSubscriptions: true,
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

let t!: Awaited<ReturnType<typeof startServer>>;

beforeEach(async () => {
	t = await startServer();
});

afterEach(async () => {
	await t.close();
	ee.removeAllListeners();
});

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

test("responseMeta header", async () => {
	const res = await fetch(
		`http://localhost:${testPort}/trpc/hello?input=${encodeURI("{}")}`,
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("test-header-meta")).toBe("test");
});

test("create context header", async () => {
	const res = await fetch(
		`http://localhost:${testPort}/trpc/hello?input=${encodeURI("{}")}`,
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("x-user")).toBe("toto");
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
