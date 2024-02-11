import { AnyRouter } from "@trpc/server";
import { HttpRequest, HttpResponse, TemplatedApp } from "uWebSockets.js";

import { WSSHandlerOptions, applyWSHandler } from "./applyWsHandler.js";
import { getCorsHeaders } from "./cors.js";
import { uWsHTTPRequestHandler } from "./requestHandler.js";
import {
	type WrappedHTTPRequest,
	type WrappedHTTPResponse,
	uHTTPHandlerOptions,
} from "./types.js";
import {
	extractAndWrapHttpRequest,
	extractAndWrapHttpResponse,
} from "./utils.js";

/**
 * @param uWsApp uWebSockets server instance
 * @param prefix The path to trpc without trailing slash (ex: "/trpc")
 * @param opts handler options
 */
export function createUWebSocketsHandler<TRouter extends AnyRouter>(
	uWsApp: TemplatedApp,
	prefix: string,
	opts: uHTTPHandlerOptions<TRouter, WrappedHTTPRequest, WrappedHTTPResponse>,
) {
	const handler = (res: HttpResponse, req: HttpRequest) => {
		const wrappedReq = extractAndWrapHttpRequest(prefix, req);
		const wrappedRes = extractAndWrapHttpResponse(
			wrappedReq.method,
			res,
			opts.maxBodySize,
		);

		uWsHTTPRequestHandler({
			path: wrappedReq.url,
			req: wrappedReq,
			res: wrappedRes,
			...opts,
		});
	};

	if (opts.cors) {
		uWsApp.options(`${prefix}/*`, (res) => {
			const headers = getCorsHeaders(opts.cors);
			res.cork(() => {
				for (const [key, value] of Object.entries(headers)) {
					res.writeHeader(key, value);
				}

				res.endWithoutBody();
			});
		});
	}

	uWsApp.get(`${prefix}/*`, handler);
	uWsApp.post(`${prefix}/*`, handler);

	if (opts.enableSubscriptions) {
		applyWSHandler(prefix, opts as unknown as WSSHandlerOptions<TRouter>);
	}
}
