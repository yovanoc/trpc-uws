import { TRPCError } from "@trpc/server";
import { HttpRequest, HttpResponse } from "uWebSockets.js";

import { WrappedHTTPRequest } from "./types.js";

export const getPostBody = <
	// TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	// TResponse extends WrappedHTTPResponse
>(
	method: TRequest["method"],
	res: HttpResponse,
	maxBodySize?: number,
) =>
	new Promise<
		| { data: unknown; ok: true; preprocessed: boolean }
		| { error: TRPCError; ok: false }
	>((resolve) => {
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
			res.aborted = true;
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
