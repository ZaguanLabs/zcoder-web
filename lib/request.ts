export class BodyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0) throw new BodyError("Invalid content length", 400);
  if (declared > maxBytes) throw new BodyError("Request is too large", 413);
  if (!request.body) throw new BodyError("Request body is required", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new BodyError("Request is too large", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new BodyError("Request body is not valid UTF-8", 400);
  }
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedRequestText(request, maxBytes));
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError("Invalid JSON request", 400);
  }
}

export async function readBoundedForm(request: Request, maxBytes: number): Promise<Record<string, string>> {
  const params = new URLSearchParams(await readBoundedRequestText(request, maxBytes));
  return Object.fromEntries(params.entries());
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) throw new BodyError("Remote response exceeded the safety limit", 502);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new BodyError("Remote response exceeded the safety limit", 502);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
