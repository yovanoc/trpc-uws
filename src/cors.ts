import type { Cors, WrappedHTTPRequest } from "./types.js";

export const getCorsHeaders = ({
	cors,
	req,
}: {
	cors?: Cors;
	req: WrappedHTTPRequest;
}) => {
	const headers: Record<string, string> = {};

	if (!cors) {
		return headers;
	}

	const c = cors;
	const allowOrigin =
		c === true || !c.origin
			? req.headers.origin || "*"
			: Array.isArray(c.origin)
				? c.origin.join(",")
				: c.origin;
	const allowHeaders =
		c === true || !c.headers
			? "origin, content-type, accept, authorization"
			: c.headers.join(", ");

	headers["Access-Control-Allow-Origin"] = allowOrigin;
	headers["Access-Control-Allow-Methods"] = req.method; //"GET, POST, PUT, DELETE, OPTIONS";
	headers["Access-Control-Allow-Headers"] = allowHeaders;
	headers["Access-Control-Allow-Credentials"] = "true";
	headers["Access-Control-Max-Age"] = "3600";

	return headers;
};
