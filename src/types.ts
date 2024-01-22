import type { AnyRouter } from "@trpc/server";
import type {
	NodeHTTPCreateContextFnOptions,
	NodeHTTPCreateContextOption,
} from "@trpc/server/adapters/node-http";
import type { HTTPBaseHandlerOptions } from "@trpc/server/http";
import type { HttpResponse } from "uWebSockets.js";

export type MaybePromise<T> = Promise<T> | T;

/**
 * @internal
 */
type ConnectMiddleware<
	TRequest extends WrappedHTTPRequest = WrappedHTTPRequest,
	TResponse extends WrappedHTTPResponse = WrappedHTTPResponse,
> = (req: TRequest, res: TResponse, next: (err?: unknown) => unknown) => void;

export interface WrappedHTTPRequest {
	headers: Record<string, string>;
	method: "GET" | "POST";
	query: URLSearchParams;
	url: string;
}

export type WrappedHTTPResponse = HttpResponse;

export type uHTTPHandlerOptions<
	TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	TResponse extends WrappedHTTPResponse,
> = HTTPBaseHandlerOptions<TRouter, TRequest> &
	NodeHTTPCreateContextOption<TRouter, TRequest, TResponse> & {
		cors?: { headers?: string[]; origin?: string | string[] } | boolean;
		// experimental_contentTypeHandlers?: NodeHTTPContentTypeHandler<
		//   TRequest,
		//   TResponse
		// >[];
		enableSubscriptions?: boolean;
		maxBodySize?: number;
		middleware?: ConnectMiddleware;
	};

export type uHTTPRequestHandlerOptions<
	TRouter extends AnyRouter,
	TRequest extends WrappedHTTPRequest,
	TResponse extends WrappedHTTPResponse,
> = {
	path: string;
	req: TRequest;
	res: TResponse;
} & uHTTPHandlerOptions<TRouter, TRequest, TResponse>;

export type CreateContextOptions = NodeHTTPCreateContextFnOptions<
	WrappedHTTPRequest,
	WrappedHTTPResponse
>;
