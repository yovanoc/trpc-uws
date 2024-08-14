import { AnyRouter } from "@trpc/server";
// eslint-disable-next-line n/no-missing-import
import { HttpRequest, HttpResponse, TemplatedApp } from "uWebSockets.js";

import { applyWSHandler, WSSHandlerOptions } from "./applyWsHandler.js";
import { cors } from "./cors.js";
import { uWsHTTPRequestHandler } from "./requestHandler.js";
import {
	uHTTPHandlerOptions,
	type WrappedHTTPRequest,
	type WrappedHTTPResponse,
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
			wrappedReq,
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
		uWsApp.options(`${prefix}/*`, async (res, req) => {
			const headers = await cors(
				extractAndWrapHttpRequest(prefix, req),
				opts.cors,
			);
			res.cork(() => {
				headers.forEach((v, k) => {
					res.writeHeader(k, v);
				});

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
