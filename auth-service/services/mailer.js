/**
 * Minimal nodemailer-based email sender for auth-service.
 * All SMTP credentials come from environment variables — never hardcoded.
 *
 * Required environment variables (add to auth-service/.env):
 *   SMTP_HOST    — e.g. smtp.mailtrap.io (dev) / smtp.sendgrid.net (prod)
 *   SMTP_PORT    — e.g. 587
 *   SMTP_USER    — SMTP username / API key
 *   SMTP_PASS    — SMTP password / API secret
 *   SMTP_FROM    — e.g. "Markee <no-reply@markee.ca>"
 *   APP_BASE_URL — e.g. http://localhost:4000 (dev) / https://markee.azah.local (prod)
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;

    const {
        SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
    } = process.env;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
        console.warn('[MAILER] SMTP not configured — emails will not be sent. Set SMTP_HOST, SMTP_USER, SMTP_PASS in auth-service/.env');
        return null;
    }

    _transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587', 10),
        secure: parseInt(SMTP_PORT || '587', 10) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    return _transporter;
}

/**
 * Send a password reset email.
 * @param {string} to        — recipient email address
 * @param {string} resetLink — full absolute URL with the raw token in the query string
 */
async function sendPasswordResetEmail(to, resetLink) {
    const transporter = getTransporter();
    if (!transporter) return; // SMTP not configured — fail silently (logged in getTransporter)

    const from = process.env.SMTP_FROM || 'Markee <no-reply@markee.ca>';

    await transporter.sendMail({
        from,
        to,
        subject: 'Reset your Markee password',
        text: [
            'Hi,',
            '',
            'You requested a password reset for your Markee account.',
            '',
            'Click the link below to set a new password. The link expires in 1 hour.',
            '',
            resetLink,
            '',
            'If you did not request this, you can safely ignore this email.',
            'Your password will not change until you click the link above.',
            '',
            '— The Markee Team'
        ].join('\n'),
        html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem 1.5rem;background:#0f1117;color:#f1f5f9;border-radius:12px">
                <div style="margin-bottom:1.5rem">
                    <span style="font-size:1.4rem;font-weight:800;color:#ff2d55;letter-spacing:-0.5px">Markee</span>
                </div>
                <h2 style="margin:0 0 0.75rem;font-size:1.25rem;font-weight:700">Reset your password</h2>
                <p style="color:#94a3b8;margin:0 0 1.5rem;line-height:1.6">
                    You requested a password reset. Click the button below to set a new password.
                    This link expires in <strong style="color:#f1f5f9">1 hour</strong>.
                </p>
                <a href="${resetLink}" style="display:inline-block;padding:0.75rem 1.5rem;background:#ff2d55;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:0.95rem">
                    Reset Password →
                </a>
                <p style="color:#64748b;font-size:0.8rem;margin-top:2rem;border-top:1px solid #1e293b;padding-top:1rem">
                    If you did not request this, ignore this email. Your password won't change.
                </p>
            </div>
        `
    });
}

module.exports = { sendPasswordResetEmail };
