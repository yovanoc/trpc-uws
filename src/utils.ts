import { TRPCError } from "@trpc/server";
import { HttpRequest, HttpResponse } from "uWebSockets.js";

import type {
	WrappedHTTPRequest,
	WrappedHTTPResponse,
	WrappedHttpResponseWS,
} from "./types.js";

import { getCorsHeaders } from "./cors.js";

export type TrpcBody =
	| { data: string | undefined; ok: true; preprocessed: boolean }
	| { error: TRPCError; ok: false };

export const getPostBody = <
	// TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	// TResponse extends WrappedHTTPResponse,
>(
	method: TRequest["method"],
	res: HttpResponse,
	aborted: { value: boolean },
	maxBodySize?: number,
) =>
	new Promise<TrpcBody>((resolve) => {
		if (method === "GET") {
			// no body in get request
			resolve({
				data: undefined,
				ok: true,
				preprocessed: false,
			});
		}

		let buffer: Buffer | undefined;

		res.onData((ab, isLast) => {
			//resolve right away if there is only one chunk
			if (buffer === undefined && isLast) {
				resolve({
					data: Buffer.from(ab).toString(),
					ok: true,
					preprocessed: false,
				});
				return;
			}

			const chunk = Buffer.from(ab);

			if (maxBodySize && buffer && buffer.length >= maxBodySize) {
				resolve({
					error: new TRPCError({ code: "PAYLOAD_TOO_LARGE" }),
					ok: false,
				});
			}

			if (buffer) {
				// else accumulate
				buffer = Buffer.concat([buffer, chunk]);
			} else {
				buffer = Buffer.concat([chunk]);
			}

			if (isLast) {
				resolve({
					data: buffer.toString(),
					ok: true,
					preprocessed: false,
				});
			}
		});

		res.onAborted(() => {
			aborted.value = true;
			resolve({
				error: new TRPCError({ code: "CLIENT_CLOSED_REQUEST" }),
				ok: false,
			});
		});
	});

export function extractAndWrapHttpRequest(
	prefix: string,
	req: HttpRequest,
): WrappedHTTPRequest {
	const method = req.getMethod().toUpperCase() as "GET" | "POST";
	const url = req.getUrl().substring(prefix.length + 1);
	const query = new URLSearchParams(req.getQuery());

	const headers: Record<string, string> = {};
	req.forEach((key, value) => {
		headers[key] = value;
	});

	return {
		headers,
		method,
		query,
		url,
	};
}

export function extractAndWrapHttpResponse(
	req: WrappedHTTPRequest,
	res: HttpResponse,
	maxBodySize?: number,
): WrappedHTTPResponse {
	const finalHeaders: Record<string, string> = {};
	let finalStatus: string | undefined = undefined;
	const aborted = { value: false };

	const ipProxied = Buffer.from(res.getProxiedRemoteAddressAsText()).toString();
	const ip =
		ipProxied !== ""
			? ipProxied
			: Buffer.from(res.getRemoteAddressAsText()).toString();

	const wrappedRes: WrappedHTTPResponse = {
		aborted: () => aborted.value,
		body: getPostBody(req.method, res, aborted, maxBodySize),
		end: (trpcRes, cors) => {
			if (wrappedRes.aborted()) {
				return;
			}

			res.cork(() => {
				// TODO final status
				res.writeStatus(finalStatus ?? trpcRes.status.toString()); // is this okay?

				// console.dir({
				// 	"res.finalHeaders": res.finalHeaders,
				// 	"res.finalStatus": res.finalStatus,
				// 	"result.headers": result.headers,
				// 	"result.status": result.status,
				// });

				const headers = {
					...getCorsHeaders({
						cors,
						req,
					}),
					...finalHeaders,
					...trpcRes.headers,
				};

				// console.dir({ headers });

				// old school way of writing headers
				for (const [key, value] of Object.entries(headers)) {
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

				res.end(trpcRes.body);
			});
		},
		ip,
		writeHeader(key, value) {
			finalHeaders[key] = value;
		},
		writeStatus(status) {
			finalStatus = status;
		},
	};

	return wrappedRes;
}

export function extractAndWrapHttpResponseWS(
	headers: Record<string, string>,
	res: HttpResponse,
): WrappedHttpResponseWS {
	const ipProxied = Buffer.from(res.getProxiedRemoteAddressAsText()).toString();
	const ip =
		ipProxied !== ""
			? ipProxied
			: Buffer.from(res.getRemoteAddressAsText()).toString();

	const wrappedRes: WrappedHttpResponseWS = {
		ip,
		writeHeader(key, value) {
			headers[key] = value;
		},
	};

	return wrappedRes;
}
