import nodemailer from 'nodemailer';
import type { VerifyCodeSender } from '../context.ts';

/** Gửi mã xác thực qua email bằng SMTP. Chưa cấu hình SMTP_URL → undefined. */
export function createMailer(env: NodeJS.ProcessEnv): VerifyCodeSender | undefined {
  if (!env.SMTP_URL) return undefined;
  const transport = nodemailer.createTransport(env.SMTP_URL);
  const from = env.SMTP_FROM || 'Multi-Cam Recorder <no-reply@multicam.local>';
  return {
    async send({ target, purpose, code, expiresInSec }) {
      const what = purpose === 'signup' ? 'kích hoạt tài khoản' : 'đặt lại mật khẩu';
      await transport.sendMail({
        from,
        to: target,
        subject: `[Multi-Cam] Mã xác thực: ${code}`,
        text: `Mã xác thực để ${what}: ${code}\nMã có hiệu lực ${Math.round(expiresInSec / 60)} phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
      });
    },
  };
}
