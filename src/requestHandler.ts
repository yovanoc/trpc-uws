import { AnyRouter } from "@trpc/server";
import {
	type HTTPRequest,
	type ResolveHTTPRequestOptionsContextFn,
	resolveHTTPResponse,
} from "@trpc/server/http";

import {
	uHTTPRequestHandlerOptions,
	type WrappedHTTPRequest,
	type WrappedHTTPResponse,
} from "./types.js";

export function uWsHTTPRequestHandler<
	TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	TResponse extends WrappedHTTPResponse,
>(opts: uHTTPRequestHandlerOptions<TRouter, TRequest, TResponse>) {
	const handleViaMiddleware = opts.middleware ?? ((_req, _res, next) => next());
	handleViaMiddleware(opts.req, opts.res, async (err) => {
		if (err) {
			if (err instanceof Error) {
				throw err;
			} else {
				throw new Error(String(err));
			}
		}

		const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
			innerOpts,
		) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return await opts.createContext?.({
				...opts,
				...innerOpts,
			});
		};

		// this may not be needed
		const query = new URLSearchParams(opts.req.query);

		const bodyResult = await opts.res.body;

		if (opts.res.aborted()) {
			return;
		}

		const reqObj: HTTPRequest = {
			body: bodyResult.ok ? bodyResult.data : undefined,
			headers: opts.req.headers,
			method: opts.req.method,
			query,
		};

		const result = await resolveHTTPResponse({
			allowBatching: opts.allowBatching,
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

		void opts.res.end(result, opts.cors);
	});
}
