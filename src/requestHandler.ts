import { AnyRouter } from "@trpc/server";
import {
	type HTTPRequest,
	type ResolveHTTPRequestOptionsContextFn,
	resolveHTTPResponse,
} from "@trpc/server/http";

import {
	WrappedHTTPRequest,
	WrappedHTTPResponse,
	uHTTPRequestHandlerOptions,
} from "./types.js";
import { getPostBody } from "./utils.js";

export function uWsHTTPRequestHandler<
	TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	TResponse extends WrappedHTTPResponse,
>(opts: uHTTPRequestHandlerOptions<TRouter, TRequest, TResponse>) {
	const handleViaMiddleware = opts.middleware ?? ((_req, _res, next) => next());
	handleViaMiddleware(opts.req, opts.res, async (err) => {
		if (err) {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw err;
		}

		const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
			innerOpts,
		) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return opts.createContext?.({
				req: opts.req,
				res: opts.res,
				...innerOpts,
			});
		};

		// this may not be needed
		const query = new URLSearchParams(opts.req.query);

		const { req, res } = opts;

		const bodyResult = await getPostBody(req.method, res, opts.maxBodySize);

		if (res.aborted) {
			return;
		}

		const reqObj: HTTPRequest = {
			body: bodyResult.ok ? bodyResult.data : undefined,
			headers: opts.req.headers,
			method: opts.req.method,
			query,
		};

		const result = await resolveHTTPResponse({
			batching: opts.batching,
			createContext,
			error: bodyResult.ok ? null : bodyResult.error,
			onError(o) {
				opts.onError?.({
					...o,
					req: opts.req,
				});
			},
			path: opts.path,
			preprocessedBody: false,
			req: reqObj,
			responseMeta: opts.responseMeta,
			router: opts.router,
		});

		if (res.aborted) {
			return;
		}

		res.cork(() => {
			res.writeStatus(result.status.toString()); // is this okay?

			// old school way of writing headers
			for (const [key, value] of Object.entries(result.headers ?? {})) {
				if (typeof value === "undefined") {
					continue;
				}

				if (Array.isArray(value)) {
					for (const v of value) {
						res.writeHeader(key, v);
					}
				} else {
					res.writeHeader(key, value);
				}
			}

			res.end(result.body);
		});
	});
}
