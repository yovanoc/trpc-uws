import { AnyRouter } from "@trpc/server";
import { HttpRequest, HttpResponse, TemplatedApp } from "uWebSockets.js";

import { WSSHandlerOptions, applyWSHandler } from "./applyWsHandler.js";
import { uWsHTTPRequestHandler } from "./requestHandler.js";
import { WrappedHTTPRequest, uHTTPHandlerOptions } from "./types.js";
import { extractAndWrapHttpRequest } from "./utils.js";

/**
 * @param uWsApp uWebSockets server instance
 * @param prefix The path to trpc without trailing slash (ex: "/trpc")
 * @param opts handler options
 */
export function createUWebSocketsHandler<TRouter extends AnyRouter>(
	uWsApp: TemplatedApp,
	prefix: string,
	opts: uHTTPHandlerOptions<TRouter, WrappedHTTPRequest, HttpResponse>,
) {
	const handler = (res: HttpResponse, req: HttpRequest) => {
		res.onAborted(() => {
			// console.log('request was aborted');
			res.aborted = true;
		});

		const wrappedReq = extractAndWrapHttpRequest(prefix, req);

		uWsHTTPRequestHandler({
			path: wrappedReq.url,
			req: wrappedReq,
			res,
			...opts,
		});
	};

	uWsApp.get(`${prefix}/*`, handler);
	uWsApp.post(`${prefix}/*`, handler);

	if (opts.enableSubscriptions) {
		applyWSHandler(prefix, opts as WSSHandlerOptions<TRouter>);
	}
}
