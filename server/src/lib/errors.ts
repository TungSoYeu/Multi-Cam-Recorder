import { Codes, CodeMessages, type Code } from '../../../packages/shared/src/codes.ts';

export { Codes };

/** Lỗi nghiệp vụ: luôn trả HTTP 200 với {code, message, data} theo bảng mã response. */
export class ApiError extends Error {
  readonly code: Code;
  readonly data: unknown;
  constructor(code: Code, message?: string, data: unknown = null) {
    super(message ?? CodeMessages[code]);
    this.code = code;
    this.data = data;
  }
}

export const fail = (code: Code, message?: string, data?: unknown): never => {
  throw new ApiError(code, message, data);
};

export const ok = <T>(data: T) => ({ code: Codes.OK, message: CodeMessages[Codes.OK], data });

export const envelope = (code: Code, message?: string, data: unknown = null) => ({
  code,
  message: message ?? CodeMessages[code],
  data,
});
