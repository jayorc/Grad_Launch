import type { NextRequest } from "next/server";

const API_TARGET = process.env.GRADLAUNCH_API_BASE_URL ?? "http://127.0.0.1:4000";

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function proxyRequest(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const upstreamUrl = new URL(`${API_TARGET}/${path.join("/")}`);
  upstreamUrl.search = request.nextUrl.search;

  try {
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      body: shouldSendBody(request.method) ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store"
    });

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: filterResponseHeaders(response.headers)
    });
  } catch (error) {
    console.error("[GradLaunch][Web Proxy] Upstream API request failed", {
      upstreamUrl: upstreamUrl.toString(),
      method: request.method,
      detail: error instanceof Error ? error.message : "Unknown proxy error."
    });

    return Response.json(
      {
        message: `GradLaunch web could not reach the API server at ${API_TARGET}.`,
        detail: error instanceof Error ? error.message : "Unknown proxy error."
      },
      { status: 502 }
    );
  }
}

function buildUpstreamHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("host", new URL(API_TARGET).host);
  return headers;
}

function filterResponseHeaders(headers: Headers) {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("content-encoding");
  nextHeaders.delete("content-length");
  nextHeaders.delete("transfer-encoding");
  return nextHeaders;
}

function shouldSendBody(method: string) {
  return method !== "GET" && method !== "HEAD";
}
