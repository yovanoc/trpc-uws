import type { BaseHandlerOptions } from "@trpc/server/http";

import {
	AnyRouter,
	TRPCError,
	callProcedure,
	getTRPCErrorFromUnknown,
	inferRouterContext,
	transformTRPCResponse,
} from "@trpc/server";
import { type NodeHTTPCreateContextFnOptions } from "@trpc/server/adapters/node-http";
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
	type RouterRecord,
	getCauseFromUnknown,
} from "@trpc/server/unstable-core-do-not-import";
import {
	type CompressOptions,
	type HttpResponse,
	SHARED_COMPRESSOR,
	TemplatedApp,
	WebSocket,
} from "uWebSockets.js";

import {
	type MaybePromise,
	WrappedHTTPRequest,
	type WrappedHttpResponseWS,
} from "./types.js";
import {
	extractAndWrapHttpRequest,
	extractAndWrapHttpResponseWS,
} from "./utils.js";

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
	NodeHTTPCreateContextFnOptions<WrappedHTTPRequest, WrappedHttpResponseWS>,
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

interface UserData<TRouter extends AnyRouter> {
	ctx: inferRouterContext<TRouter> | undefined;
	id: string;
	req: WrappedHTTPRequest;
}

export const applyWSHandler = <TRouter extends AnyRouter>(
	prefix: string,
	opts: WSSHandlerOptions<TRouter>,
) => {
	const { app, createContext, router } = opts;

	const { transformer } = router._def._config;

	const randomKey = Math.random().toString(36).slice(2);

	const broadcastKey = `${randomKey}-broadcastReconnectNotification`;

	const allClientsSubscriptions = new Map<
		string,
		Map<number | string, Unsubscribable>
	>();

	const respond = (
		client: WebSocket<UserData<TRouter>>,
		untransformedJSON: TRPCResponseMessage,
	) => {
		client.send(
			JSON.stringify(
				// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
				transformTRPCResponse(router._def._config, untransformedJSON),
			),
		);
	};

	const closeUpgrade = (
		res: HttpResponse,
		untransformedJSON: TRPCResponseMessage,
	) => {
		res.cork(() => {
			res.writeStatus("403").end(
				JSON.stringify(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
					transformTRPCResponse(router._def._config, untransformedJSON),
				),
			);
		});
	};

	const stopSubscription = (
		client: WebSocket<UserData<TRouter>>,
		subscription: Unsubscribable,
		{ id, jsonrpc }: JSONRPC2.BaseEnvelope & { id: JSONRPC2.RequestId },
	) => {
		subscription.unsubscribe();

		respond(client, {
			id,
			jsonrpc,
			result: {
				type: "stopped",
			},
		});
	};

	const handleRequest = async (
		client: WebSocket<UserData<TRouter>>,
		msg: TRPCClientOutgoingMessage,
	) => {
		const wsData = client.getUserData();
		let clientsSubscriptions = allClientsSubscriptions.get(wsData.id);
		if (!clientsSubscriptions) {
			clientsSubscriptions = new Map();
			allClientsSubscriptions.set(wsData.id, clientsSubscriptions);
		}

		const { id, jsonrpc } = msg;

		if (id === null) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "`id` is required",
			});
		}

		if (msg.method === "subscription.stop") {
			const sub = clientsSubscriptions.get(id);
			if (sub) {
				stopSubscription(client, sub, { id, jsonrpc });
			}

			clientsSubscriptions.delete(id);

			return;
		}

		const { input, path } = msg.params;

		const type = msg.method;
		try {
			const result = await callProcedure({
				ctx: wsData.ctx,
				// eslint-disable-next-line @typescript-eslint/require-await
				getRawInput: async () => input,
				path,
				procedures: router._def.procedures as RouterRecord,
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
						ctx: wsData.ctx,
						error,
						input,
						path,
						req: wsData.req,
						type,
					});
					respond(client, {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
						error: getErrorShape({
							config: router._def._config,
							ctx: wsData.ctx,
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

			// if (client.readyState !== client.OPEN) {
			//   // if the client got disconnected whilst initializing the subscription
			//   // no need to send stopped message if the client is disconnected
			//   sub.unsubscribe();
			//   return;
			// }

			if (clientsSubscriptions.has(id)) {
				// duplicate request ids for client
				stopSubscription(client, sub, { id, jsonrpc });
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Duplicate id ${id}`,
				});
			}

			clientsSubscriptions.set(id, sub);

			respond(client, {
				id,
				jsonrpc,
				result: {
					type: "started",
				},
			});
		} catch (cause) {
			// procedure threw an error
			const error = getTRPCErrorFromUnknown(cause);
			opts.onError?.({
				ctx: wsData.ctx,
				error,
				input,
				path,
				req: wsData.req,
				type,
			});
			respond(client, {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				error: getErrorShape({
					config: router._def._config,
					ctx: wsData.ctx,
					error,
					input,
					path,
					type,
				}),
				id,
				jsonrpc,
			});
		}
	};

	app.ws<UserData<TRouter>>(prefix, {
		compression: SHARED_COMPRESSOR,
		// maxPayloadLength: 5 * 1024 * 1024,
		// maxBackpressure,
		// idleTimeout: ms.minutes(5) / 1000,
		close: (ws) => {
			const id = ws.getUserData().id;
			const clientSubs = allClientsSubscriptions.get(id);
			if (!clientSubs) {
				return;
			}

			for (const sub of clientSubs.values()) {
				sub.unsubscribe();
			}

			clientSubs.clear();
			allClientsSubscriptions.delete(id);
		},
		message: async (client, message) => {
			try {
				const received = Buffer.from(message.slice(0)).toString();
				const msgJSON: unknown = JSON.parse(received);
				const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
				const promises = msgs
					.map((raw) => parseTRPCMessage(raw, transformer))
					.map((msg) => handleRequest(client, msg));
				await Promise.all(promises);
			} catch (cause) {
				const error = new TRPCError({
					cause: getCauseFromUnknown(cause),
					code: "PARSE_ERROR",
				});

				respond(client, {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
		open: (client) => {
			client.subscribe(broadcastKey);
		},
		upgrade: async (res, req, context) => {
			res.onAborted(() => {
				upgradeAborted.aborted = true;
			});

			const upgradeAborted = { aborted: false };

			const wrappedReq = extractAndWrapHttpRequest(prefix, req);
			const headers: Record<string, string> = {};
			const wrappedRes = extractAndWrapHttpResponseWS(headers, res);

			const secWebSocketKey = wrappedReq.headers["sec-websocket-key"];
			const secWebSocketProtocol = wrappedReq.headers["sec-websocket-protocol"];
			const secWebSocketExtensions =
				wrappedReq.headers["sec-websocket-extensions"];

			const data: UserData<TRouter> = {
				ctx: undefined,
				id: Math.random().toString(36).slice(2),
				req: wrappedReq,
			};

			try {
				data.ctx = await createContext?.({
					req: wrappedReq,
					res: wrappedRes,
				});
			} catch (cause) {
				const error = getTRPCErrorFromUnknown(cause);
				opts.onError?.({
					ctx: data.ctx,
					error,
					input: undefined,
					path: undefined,
					req: wrappedReq,
					type: "unknown",
				});

				if (upgradeAborted.aborted) {
					/* You must not upgrade now */
					return;
				}

				closeUpgrade(res, {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
				return;
			}

			if (upgradeAborted.aborted) {
				/* You must not upgrade now */
				return;
			}

			/* Cork any async response including upgrade */
			res.cork(() => {
				res.writeStatus("101 Switching Protocols");
				for (const [key, value] of Object.entries(headers)) {
					res.writeHeader(key, value);
				}

				/* This immediately calls open handler, you must not use res after this call */
				res.upgrade(
					data,
					/* Use our copies here */
					secWebSocketKey,
					secWebSocketProtocol,
					secWebSocketExtensions,
					context,
				);
			});
		},
	});

	return {
		broadcastReconnectNotification: () => {
			const response: TRPCReconnectNotification = {
				id: null,
				method: "reconnect",
			};
			const data = JSON.stringify(response);
			app.publish(broadcastKey, data);
			// for (const client of wss.clients) {
			//   if (client.readyState === 1 /* ws.OPEN */) {
			//     client.send(data);
			//   }
			// }
		},
	};
};
