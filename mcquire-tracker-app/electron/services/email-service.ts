import nodemailer from 'nodemailer'
import { safeStorage, app } from 'electron'
import type { CompatDb } from './database'
import fs from 'fs'
import path from 'path'

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

export function storeSmtpConfig(config: SmtpConfig): void {
  const encrypted = safeStorage.encryptString(JSON.stringify(config))
  fs.writeFileSync(path.join(app.getPath('userData'), 'smtp.enc'), encrypted)
}

export function loadSmtpConfig(): SmtpConfig | null {
  try {
    const p = path.join(app.getPath('userData'), 'smtp.enc')
    if (!fs.existsSync(p)) return null
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(p)))
  } catch { return null }
}

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  const cfg = loadSmtpConfig()
  if (!cfg) return null
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password }
  })
}

export async function sendTestEmail(toEmail: string): Promise<{ success: boolean; error?: string }> {
  const transport = await getTransporter()
  if (!transport) return { success: false, error: 'SMTP not configured' }
  try {
    await transport.sendMail({
      from: `"McQuire Tracker" <${loadSmtpConfig()?.user}>`,
      to: toEmail,
      subject: 'McQuire Tracker — Test Email',
      html: '<h2>Test email from McQuire Tracker</h2><p>Your email notification settings are working correctly.</p>'
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// ─── EmailService class — used by SyncScheduler for automated notifications ───

export class EmailService {
  private static instance: EmailService | null = null

  // db is accepted to match the call signature in SyncScheduler but is not needed
  // for the current send implementation (SMTP config is stored in smtp.enc)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private constructor(_db: CompatDb) {}

  static getInstance(db: CompatDb): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService(db)
    }
    return EmailService.instance
  }

  async send(opts: { to: string; subject: string; html: string }): Promise<void> {
    const transport = await getTransporter()
    if (!transport) return
    await transport.sendMail({
      from: `"McQuire Tracker" <${loadSmtpConfig()?.user}>`,
      ...opts,
    })
  }
}
