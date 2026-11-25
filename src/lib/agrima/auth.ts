/* =========================================================================
   auth.ts — local authentication, 100% offline (replaces Supabase Auth)
   -------------------------------------------------------------------------
   • Passwords are NEVER stored in clear text: PBKDF2-SHA256 via WebCrypto,
     random 16-byte salt, 150,000 iterations, stored as
     `pbkdf2$<iter>$<saltB64>$<hashB64>` inside the local `users` store.
   • First-run setup: the FIRST screen creates the system admin account —
     no hardcoded credentials anywhere in the code or repository.
   • Session: localStorage token + expiry (7 days), validated against the
     local users store on every boot. Logout clears it.
   • Simple brute-force throttle: exponential backoff per email.
   ========================================================================= */

import { db, repo, uuid } from './db';
import type { LocalUser, Role, SessionProfile } from './types';

const SESSION_KEY = 'agrima_local_session';
const THROTTLE_KEY = 'agrima_login_throttle';
const PBKDF2_ITERATIONS = 150000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt.buffer as ArrayBuffer)}$${toB64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !hashB64) return false;
    const iterations = Number(iterStr) || 0;
    if (!iterations) return false;
    const bits = await derive(password, fromB64(saltB64), iterations);
    const expected = fromB64(hashB64);
    const got = new Uint8Array(bits);
    if (got.length !== expected.length) return false;
    let diff = 0; // constant-time-ish compare
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export function generatePassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  const rnd = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(rnd, (n) => chars[n % chars.length]).join('');
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function toProfile(u: LocalUser): SessionProfile {
  return { id: u.id, email: u.email, fullName: u.fullName, role: u.role, active: u.active };
}

/* ------------------------------ users CRUD ------------------------------ */

export async function usersCount(): Promise<number> {
  return repo.users().then((r) => r.length);
}

export async function listUsers(): Promise<LocalUser[]> {
  const rows = await repo.users();
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows;
}

export async function createFirstAdmin(email: string, fullName: string, password: string): Promise<SessionProfile> {
  const existing = await repo.users();
  if (existing.length > 0) throw new Error('تم إنشاء مدير النظام مسبقًا');
  if (!isValidEmail(email)) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا');
  if (password.length < 8) throw new Error('كلمة المرور 8 أحرف على الأقل');
  const passHash = await hashPassword(password);
  const user: LocalUser = {
    id: uuid(),
    email: email.trim().toLowerCase(),
    fullName: fullName.trim() || 'مدير النظام',
    role: 'admin',
    active: true,
    passHash,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  await db.put('users', user);
  await db.logAudit({ entity: 'user', action: 'user-create', entityId: user.id, details: `إنشاء مدير النظام الأول (${user.email}) — إعداد أول تشغيل` , actor: user.email });
  return toProfile(user);
}

export async function createUser(input: {
  email: string; fullName: string; role: Role; password: string; actor?: string;
}): Promise<{ user: LocalUser; plainPassword: string }> {
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا');
  if (!input.password || input.password.length < 8) throw new Error('كلمة المرور 8 أحرف على الأقل');
  if (!input.role) throw new Error('اختر دور المستخدم');
  const users = await repo.users();
  if (users.some((u) => u.email === email)) throw new Error('هذا البريد مسجل بالفعل');
  const passHash = await hashPassword(input.password);
  const user: LocalUser = {
    id: uuid(),
    email,
    fullName: input.fullName.trim(),
    role: input.role,
    active: true,
    passHash,
    createdAt: new Date().toISOString(),
  };
  await db.put('users', user);
  await db.logAudit({
    entity: 'user', action: 'user-create', entityId: user.id,
    details: `إنشاء مستخدم: ${email} — الدور: ${input.role === 'admin' ? 'مدير النظام' : 'أمين المخزن'}`,
    actor: input.actor,
  });
  return { user, plainPassword: input.password };
}

export async function updateUser(id: string, patch: Partial<Pick<LocalUser, 'fullName' | 'role' | 'email'>>, actor?: string): Promise<void> {
  const u = await db.get<LocalUser>('users', id);
  if (!u) throw new Error('المستخدم غير موجود');
  if (patch.email !== undefined) {
    const email = patch.email.trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error('أدخل بريدًا إلكترونيًا صحيحًا');
    const users = await repo.users();
    if (users.some((x) => x.email === email && x.id !== id)) throw new Error('هذا البريد مسجل بالفعل');
    u.email = email;
  }
  if (patch.fullName !== undefined) u.fullName = patch.fullName.trim();
  if (patch.role !== undefined) u.role = patch.role;
  u.updatedAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({ entity: 'user', action: 'user-edit', entityId: id, details: `تعديل بيانات المستخدم ${u.email}`, actor });
}

export async function changeRole(id: string, role: Role | '', actor?: string): Promise<void> {
  const u = await db.get<LocalUser>('users', id);
  if (!u) throw new Error('المستخدم غير موجود');
  const prev = u.role;
  u.role = role;
  u.updatedAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({
    entity: 'user', action: 'user-role-change', entityId: id,
    details: `تغيير دور ${u.email}: ${prev || 'بدون دور'} ← ${role || 'بدون دور'}`,
    actor,
  });
}

export async function setUserActive(id: string, active: boolean, actor?: string): Promise<void> {
  const u = await db.get<LocalUser>('users', id);
  if (!u) throw new Error('المستخدم غير موجود');
  u.active = active;
  u.updatedAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({
    entity: 'user', action: active ? 'user-activate' : 'user-deactivate', entityId: id,
    details: `${active ? 'تفعيل' : 'إيقاف'} حساب ${u.email}`,
    actor,
  });
}

export async function resetPassword(id: string, newPassword: string, actor?: string): Promise<string> {
  if (!newPassword || newPassword.length < 8) throw new Error('كلمة المرور 8 أحرف على الأقل');
  const u = await db.get<LocalUser>('users', id);
  if (!u) throw new Error('المستخدم غير موجود');
  u.passHash = await hashPassword(newPassword);
  u.updatedAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({ entity: 'user', action: 'user-password-reset', entityId: id, details: `إعادة تعيين كلمة مرور ${u.email}`, actor });
  return u.email;
}

export async function changeMyPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const u = await db.get<LocalUser>('users', userId);
  if (!u) throw new Error('المستخدم غير موجود');
  const ok = await verifyPassword(currentPassword, u.passHash);
  if (!ok) throw new Error('كلمة المرور الحالية غير صحيحة');
  if (!newPassword || newPassword.length < 8) throw new Error('كلمة المرور الجديدة 8 أحرف على الأقل');
  u.passHash = await hashPassword(newPassword);
  u.updatedAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({ entity: 'user', action: 'user-password-change', entityId: userId, details: 'تغيير كلمة المرور من المستخدم نفسه', actor: u.email });
}

export async function deleteUser(id: string, selfId: string, actor?: string): Promise<void> {
  const u = await db.get<LocalUser>('users', id);
  if (!u) throw new Error('المستخدم غير موجود');
  if (id === selfId) throw new Error('لا يمكنك حذف حسابك الحالي');
  const users = await repo.users();
  const admins = users.filter((x) => x.role === 'admin' && x.active && x.id !== id);
  if (u.role === 'admin' && admins.length === 0) throw new Error('لا يمكن حذف آخر مدير نظام فعّال');
  await db.del('users', id);
  await db.logAudit({ entity: 'user', action: 'user-delete', entityId: id, details: `حذف المستخدم ${u.email}`, actor });
}

/* ------------------------------ session ------------------------------ */

interface StoredSession { userId: string; token: string; issuedAt: number; expiresAt: number }

export function saveSession(userId: string): void {
  const now = Date.now();
  const s: StoredSession = { userId, token: uuid() + uuid(), issuedAt: now, expiresAt: now + SESSION_TTL_MS };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
}

/** Returns the profile of a valid, non-expired, active session — else null. */
export async function restoreSession(): Promise<SessionProfile | null> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(SESSION_KEY); } catch { return null; }
  if (!raw) return null;
  let s: StoredSession;
  try { s = JSON.parse(raw); } catch { return null; }
  if (!s || !s.userId || !s.token || !s.expiresAt || s.expiresAt < Date.now()) {
    clearSession();
    return null;
  }
  const u = await db.get<LocalUser>('users', s.userId);
  if (!u || !u.active || !u.role) { clearSession(); return null; }
  // sliding expiry: extend on activity
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* noop */ }
  return toProfile(u);
}

/* ------------------------------ sign in ------------------------------ */

async function throttled(email: string): Promise<number> {
  let map: Record<string, { n: number; until: number }> = {};
  try { map = JSON.parse(localStorage.getItem(THROTTLE_KEY) || '{}'); } catch { /* noop */ }
  const e = map[email];
  if (e && e.until > Date.now()) return Math.ceil((e.until - Date.now()) / 1000);
  return 0;
}

function bumpThrottle(email: string): void {
  let map: Record<string, { n: number; until: number }> = {};
  try { map = JSON.parse(localStorage.getItem(THROTTLE_KEY) || '{}'); } catch { /* noop */ }
  const e = map[email] || { n: 0, until: 0 };
  e.n += 1;
  e.until = Date.now() + Math.min(60_000 * Math.pow(2, e.n - 1), 15 * 60_000);
  map[email] = e;
  try { localStorage.setItem(THROTTLE_KEY, JSON.stringify(map)); } catch { /* noop */ }
}

function clearThrottle(email: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(THROTTLE_KEY) || '{}');
    delete map[email];
    localStorage.setItem(THROTTLE_KEY, JSON.stringify(map));
  } catch { /* noop */ }
}

export async function signIn(email: string, password: string): Promise<SessionProfile> {
  const em = email.trim().toLowerCase();
  const wait = await throttled(em);
  if (wait > 0) throw new Error(`محاولات كثيرة — انتظر ${wait} ثانية ثم أعد المحاولة`);
  if (!em || !password) throw new Error('أدخل البريد وكلمة المرور');
  const users = await repo.users();
  const u = users.find((x) => x.email === em);
  // burn time even when the account does not exist (timing parity)
  const hash = u ? u.passHash : 'pbkdf2$150000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  await verifyPassword(password, hash);
  if (!u) { bumpThrottle(em); throw new Error('البريد الإلكتروني أو كلمة المرور غير صحيحة'); }
  if (!u.active) { throw new Error('هذا الحساب موقوف من مدير النظام'); }
  if (!u.role) { throw new Error('حسابك بانتظار منح الدور من مدير النظام'); }
  clearThrottle(em);
  u.lastLoginAt = new Date().toISOString();
  await db.put('users', u);
  await db.logAudit({ entity: 'user', action: 'login', entityId: u.id, details: `تسجيل دخول: ${u.email}`, actor: u.email });
  saveSession(u.id);
  return toProfile(u);
}

export async function signOut(actor?: string): Promise<void> {
  if (actor) {
    try {
      await db.logAudit({ entity: 'user', action: 'logout', entityId: actor, details: `تسجيل خروج: ${actor}`, actor });
    } catch { /* best-effort */ }
  }
  clearSession();
}
