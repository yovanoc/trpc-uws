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
	const cors = (res: HttpResponse) => {
		if (!opts.cors) {
			return;
		}

		const c = opts.cors;
		const allowOrigin =
			c === true || !c.origin
				? "*"
				: Array.isArray(c.origin)
					? c.origin.join(",")
					: c.origin;
		const allowHeaders =
			c === true || !c.headers
				? "origin, content-type, accept, authorization"
				: c.headers.join(", ");
		res.cork(() => {
			res
				.writeHeader("Access-Control-Allow-Origin", allowOrigin)
				.writeHeader(
					"Access-Control-Allow-Methods",
					"GET, POST, PUT, DELETE, OPTIONS",
				)
				.writeHeader("Access-Control-Allow-Headers", allowHeaders)
				.writeHeader("Access-Control-Allow-Credentials", "true")
				.writeHeader("Access-Control-Max-Age", "3600");
		});
	};

	const handler = (res: HttpResponse, req: HttpRequest) => {
		if (opts.cors) {
			cors(res);
		}

		const wrappedReq = extractAndWrapHttpRequest(prefix, req);

		uWsHTTPRequestHandler({
			path: wrappedReq.url,
			req: wrappedReq,
			res,
			...opts,
		});
	};

	if (opts.cors) {
		uWsApp.options(`${prefix}/*`, (res) => {
			cors(res);
			res.endWithoutBody();
		});
	}

	uWsApp.get(`${prefix}/*`, handler);
	uWsApp.post(`${prefix}/*`, handler);

	if (opts.enableSubscriptions) {
		applyWSHandler(prefix, opts as WSSHandlerOptions<TRouter>);
	}
}
