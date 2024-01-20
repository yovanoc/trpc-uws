// eslint-disable-next-line eslint-comments/disable-enable-pair
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import type { NodeHTTPCreateContextFnOptions } from "@trpc/server/adapters/node-http";
import type { BaseHandlerOptions } from "@trpc/server/http";
import type { CompressOptions, TemplatedApp, WebSocket } from "uWebSockets.js";

import {
	AnyRouter,
	TRPCError,
	callProcedure,
	getTRPCErrorFromUnknown,
	inferRouterContext,
	transformTRPCResponse,
} from "@trpc/server";
import { Unsubscribable, isObservable } from "@trpc/server/observable";
import {
	JSONRPC2,
	TRPCClientOutgoingMessage,
	TRPCReconnectNotification,
	TRPCResponseMessage,
	parseTRPCMessage,
} from "@trpc/server/rpc";
import { getErrorShape } from "@trpc/server/shared";

import {
	type MaybePromise,
	WrappedHTTPRequest,
	type WrappedHTTPResponse,
} from "./types.js";
import { extractAndWrapHttpRequest } from "./utils.js";

interface UWSBuiltInOpts {
	/** Whether or not we should automatically close the socket when a message is dropped due to backpressure. Defaults to false. */
	closeOnBackpressureLimit?: number;
	/** What per message-deflate compression to use. uWS.DISABLED, uWS.SHARED_COMPRESSOR or any of the uWS.DEDICATED_COMPRESSOR_xxxKB. Defaults to uWS.DISABLED. */
	compression?: CompressOptions;
	/**
	 * Maximum amount of seconds that may pass without sending or getting a message. Connection is closed if this timeout passes. Resolution (granularity) for timeouts are typically 4 seconds, rounded to closest.
	 * Disable by using 0. Defaults to 120.
	 */
	idleTimeout?: number;
	/** Maximum length of allowed backpressure per socket when publishing or sending messages. Slow receivers with too high backpressure will be skipped until they catch up or timeout. Defaults to 64 * 1024. */
	maxBackpressure?: number;
	/** Maximum number of minutes a WebSocket may be connected before being closed by the server. 0 disables the feature. */
	maxLifetime?: number;
	/** Maximum length of received message. If a client tries to send you a message larger than this, the connection is immediately closed. Defaults to 16 * 1024. */
	maxPayloadLength?: number;
	/** Whether or not we should automatically send pings to uphold a stable connection given whatever idleTimeout. */
	sendPingsAutomatically?: boolean;
}

/**
 */
export type CreateWSSContextFnOptions = Omit<
	NodeHTTPCreateContextFnOptions<WrappedHTTPRequest, WrappedHTTPResponse>,
	"info"
>;

/**
 */
export type CreateWSSContextFn<TRouter extends AnyRouter> = (
	opts: CreateWSSContextFnOptions,
) => MaybePromise<inferRouterContext<TRouter>>;

/**
 * Web socket server handler
 */
export type WSSHandlerOptions<TRouter extends AnyRouter> = BaseHandlerOptions<
	TRouter,
	WrappedHTTPRequest
> &
	(object extends inferRouterContext<TRouter>
		? {
				createContext?: CreateWSSContextFn<TRouter>;
			}
		: {
				createContext: CreateWSSContextFn<TRouter>;
			}) & {
		app: TemplatedApp;
		process?: NodeJS.Process;
	} & UWSBuiltInOpts;

interface Decoration<TRouter extends AnyRouter> {
	clientSubscriptions: Map<number | string, Unsubscribable>;
	ctx: inferRouterContext<TRouter> | undefined;
	ctxPromise: MaybePromise<inferRouterContext<TRouter>> | undefined;
	req: WrappedHTTPRequest;
	res: WrappedHTTPResponse;
}

export function applyWSHandler<TRouter extends AnyRouter>(
	prefix: string,
	opts: WSSHandlerOptions<TRouter>,
) {
	const { app, createContext, router } = opts;

	const { transformer } = router._def._config;

	// instead of putting data on the client, can put it here in a global map
	// const globals = new Map<WebSocket<any>, Decoration>();

	// doing above can eliminate allClients for reconnection notification
	const allClients = new Set<WebSocket<Decoration<TRouter>>>();

	function respond(
		client: WebSocket<Decoration<TRouter>>,
		untransformedJSON: TRPCResponseMessage,
	) {
		client.send(
			JSON.stringify(
				transformTRPCResponse(router._def._config, untransformedJSON),
			),
		);
	}

	function stopSubscription(
		client: WebSocket<Decoration<TRouter>>,
		subscription: Unsubscribable,
		{ id, jsonrpc }: JSONRPC2.BaseEnvelope & { id: JSONRPC2.RequestId },
	) {
		subscription.unsubscribe();

		respond(client, {
			id,
			jsonrpc,
			result: {
				type: "stopped",
			},
		});
	}

	async function handleRequest(
		client: WebSocket<Decoration<TRouter>>,
		msg: TRPCClientOutgoingMessage,
	) {
		const data = client.getUserData();
		const clientSubscriptions = data.clientSubscriptions;

		const { id, jsonrpc } = msg;
		/* istanbul ignore next -- @preserve */
		if (id === null) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "`id` is required",
			});
		}

		if (msg.method === "subscription.stop") {
			const sub = clientSubscriptions.get(id);
			if (sub) {
				stopSubscription(client, sub, { id, jsonrpc });
			}

			clientSubscriptions.delete(id);
			return;
		}

		const { input, path } = msg.params;
		const type = msg.method;
		try {
			await data.ctxPromise; // asserts context has been set

			const result = await callProcedure({
				ctx: data.ctx,
				// eslint-disable-next-line @typescript-eslint/require-await
				getRawInput: async () => input,
				path,
				procedures: router._def.procedures,
				type,
			});

			if (type === "subscription") {
				if (!isObservable(result)) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Subscription ${path} did not return an observable`,
					});
				}
			} else {
				// send the value as data if the method is not a subscription
				respond(client, {
					id,
					jsonrpc,
					result: {
						data: result,
						type: "data",
					},
				});
				return;
			}

			const observable = result;
			const sub = observable.subscribe({
				complete() {
					respond(client, {
						id,
						jsonrpc,
						result: {
							type: "stopped",
						},
					});
				},
				error(err) {
					const error = getTRPCErrorFromUnknown(err);
					opts.onError?.({
						ctx: data.ctx,
						error,
						input,
						path,
						req: data.req,
						type,
					});
					respond(client, {
						error: getErrorShape({
							config: router._def._config,
							ctx: data.ctx,
							error,
							input,
							path,
							type,
						}),
						id,
						jsonrpc,
					});
				},
				next(data) {
					respond(client, {
						id,
						jsonrpc,
						result: {
							data,
							type: "data",
						},
					});
				},
			});
			/* istanbul ignore next -- @preserve */
			// FIXME handle these edge cases
			//   if (client.readyState !== client.OPEN) {
			//     // if the client got disconnected whilst initializing the subscription
			//     // no need to send stopped message if the client is disconnected
			//     sub.unsubscribe();
			//     return;
			//   }

			/* istanbul ignore next -- @preserve */
			if (clientSubscriptions.has(id)) {
				// duplicate request ids for client
				stopSubscription(client, sub, { id, jsonrpc });
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Duplicate id ${id}`,
				});
			}

			clientSubscriptions.set(id, sub);

			respond(client, {
				id,
				jsonrpc,
				result: {
					type: "started",
				},
			});
		} catch (cause) /* istanbul ignore next -- @preserve */ {
			// procedure threw an error
			const error = getTRPCErrorFromUnknown(cause);
			opts.onError?.({
				ctx: data.ctx,
				error,
				input,
				path,
				req: data.req,
				type,
			});
			respond(client, {
				error: getErrorShape({
					config: router._def._config,
					ctx: data.ctx,
					error,
					input,
					path,
					type,
				}),
				id,
				jsonrpc,
			});
		}
	}

	app.ws(prefix, {
		close(client: WebSocket<Decoration<TRouter>>) {
			const data = client.getUserData();

			for (const sub of data.clientSubscriptions.values()) {
				sub.unsubscribe();
			}

			data.clientSubscriptions.clear();
			allClients.delete(client);
		},
		closeOnBackpressureLimit: opts.closeOnBackpressureLimit,
		compression: opts.compression,
		idleTimeout: opts.idleTimeout,
		maxBackpressure: opts.maxBackpressure,
		maxLifetime: opts.maxLifetime,
		maxPayloadLength: opts.maxPayloadLength,

		async message(client: WebSocket<Decoration<TRouter>>, rawMsg) {
			try {
				const stringMsg = Buffer.from(rawMsg).toString();

				const msgJSON: unknown = JSON.parse(stringMsg);

				const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
				const promises = msgs
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					.map((raw) => parseTRPCMessage(raw, transformer))
					.map((value) => handleRequest(client, value));

				await Promise.all(promises);
			} catch (cause) {
				const error = new TRPCError({
					cause,
					code: "PARSE_ERROR",
				});

				respond(client, {
					error: getErrorShape({
						config: router._def._config,
						ctx: undefined,
						error,
						input: undefined,
						path: undefined,
						type: "unknown",
					}),
					id: null,
				});
			}
		},
		async open(client: WebSocket<Decoration<TRouter>>) {
			async function createContextAsync() {
				const data = client.getUserData();

				try {
					data.ctx = await data.ctxPromise;
				} catch (cause) {
					const error = getTRPCErrorFromUnknown(cause);

					opts.onError?.({
						ctx: data.ctx,
						error,
						input: undefined,
						path: undefined,
						req: data.req,
						type: "unknown",
					});
					respond(client, {
						error: getErrorShape({
							config: router._def._config,
							ctx: data.ctx,
							error,
							input: undefined,
							path: undefined,
							type: "unknown",
						}),
						id: null,
					});

					// large timeout is needed in order for response above to reach the client
					// otherwise it tries to reconnect over and over again, even though the context throws
					// this is a rough edge of uWs
					setTimeout(() => {
						if (client.getUserData().res.aborted) {
							return;
						}

						client.end();
					}, 1000);

					// original code
					// (global.setImmediate ?? global.setTimeout)(() => {
					// client.end()
					// });
				}
			}

			await createContextAsync();
			allClients.add(client);
		},

		sendPingsAutomatically: opts.sendPingsAutomatically, // could this be enabled?

		upgrade: (res, req, context) => {
			res.onAborted(() => {
				res.aborted = true;
			});
			const wrappedReq = extractAndWrapHttpRequest(prefix, req);

			const secWebSocketKey = wrappedReq.headers["sec-websocket-key"];
			const secWebSocketProtocol = wrappedReq.headers["sec-websocket-protocol"];
			const secWebSocketExtensions =
				wrappedReq.headers["sec-websocket-extensions"];

			const data: Decoration<TRouter> = {
				clientSubscriptions: new Map<number | string, Unsubscribable>(),
				ctx: undefined,
				ctxPromise: createContext?.({ req: wrappedReq, res }), // this cannot use RES!
				req: wrappedReq,
				res,
			};

			res.upgrade(
				data,
				/* Spell these correctly */
				secWebSocketKey,
				secWebSocketProtocol,
				secWebSocketExtensions,
				context,
			);
		},
	});

	return {
		broadcastReconnectNotification: () => {
			const response: TRPCReconnectNotification = {
				id: null,
				method: "reconnect",
			};
			const data = JSON.stringify(response);
			for (const client of allClients) {
				client.send(data);
			}
		},
	};
}
