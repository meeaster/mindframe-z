export function redactExecutorError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|credential[-_]?provider|api[-_]?key|token|state|code)["']?)\s*[:=]\s*["']?[^,\s}"']+/gi,
      "$1=[redacted]"
    )
    .replace(/([?&](?:code|state|token|client[_-]?secret)=)[^&\s]+/gi, "$1[redacted]");
}

export function executorError(message: string): Error {
  return new Error(redactExecutorError(message));
}
