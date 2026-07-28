// supabase/functions/test-phone-auth/index.ts
//
// TEST-ONLY auth bypass. Accepts { phone, otp } and — if otp matches the
// fixed TEST_OTP value — looks up an existing user by phone in your
// EXISTING public.users table (no new table needed), or creates a new
// one, then mints a real Supabase session without ever sending a real
// SMS through Twilio.
//
// HOW SESSIONS GET MINTED WITHOUT A REAL OTP: Supabase's admin API has
// no "log this phone user in" call. The workaround: admin.generateLink
// ({type: 'magiclink'}) mints a valid one-time token for an email
// WITHOUT sending anything — it just returns the token, which the
// client exchanges via verifyOtp() for a real session. This requires
// the user to have an email on their auth.users record.
//
// EXISTING USERS: anyone who signed up through the real Twilio phone
// flow has NO email on their auth.users record — phone-only sign-in
// never sets one. The first time such a user hits this function, it
// attaches a synthetic, never-emailed-anywhere address
// (<digits>@test.pileap.internal) to their auth record so the magiclink
// trick has something to work with. This does not touch or replace
// their phone identity.
//
// SECURITY: TEST_OTP is effectively a universal password for every
// phone number in this project. This function must never be deployed
// against a production Supabase project. TEST_AUTH_SHARED_SECRET is a
// second, independent guard (checked via header) so this endpoint isn't
// wide open to the internet even in a test project — it is NOT a
// replacement for keeping this out of production.
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TEST_OTP = Deno.env.get('TEST_OTP') ?? '123456';
const SHARED_SECRET = Deno.env.get('TEST_AUTH_SHARED_SECRET')!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function syntheticEmail(phone: string) {
  // Sanitize to digits only so it's a valid email local-part regardless
  // of whether the phone was entered with '+', spaces, or dashes.
  return `${phone.replace(/[^0-9]/g, '')}@test.pileap.internal`;
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!SHARED_SECRET || req.headers.get('x-test-auth-secret') !== SHARED_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { phone, otp } = await req.json().catch(() => ({}));
  if (!phone || typeof phone !== 'string') {
    return new Response(JSON.stringify({ error: 'phone is required' }), { status: 400 });
  }
  if (otp !== TEST_OTP) {
    return new Response(JSON.stringify({ error: 'Invalid code' }), { status: 401 });
  }

  try {
    // 1. Look up an existing user by phone in your EXISTING users table.
    const { data: existingRow, error: lookupErr } = await admin
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    let email: string;

    if (existingRow) {
      // Found — as usual, sign in the existing user. Check whether they
      // already have an email (e.g. from a previous test sign-in); if
      // not (the normal case for real-Twilio-created users), attach the
      // synthetic one now — see file header.
      const { data: userData, error: getErr } = await admin.auth.admin.getUserById(existingRow.id);
      if (getErr) throw getErr;

      if (userData.user.email) {
        email = userData.user.email;
      } else {
        email = syntheticEmail(phone);
        const { error: updateErr } = await admin.auth.admin.updateUserById(existingRow.id, {
          email,
          email_confirm: true,
        });
        if (updateErr) throw updateErr;
      }
    } else {
      // Not found — create a new user, matching normal sign-up behavior.
      // phone_confirm/email_confirm: true since there's no real SMS or
      // email being sent for the user to confirm through.
      email = syntheticEmail(phone);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        phone,
        email,
        phone_confirm: true,
        email_confirm: true,
      });
      if (createErr) throw createErr;

      // Mirror the new user into your existing public.users table —
      // upsert (not insert) in case some other part of the app also
      // populates this table independently.
      const { error: upsertErr } = await admin
        .from('users')
        .upsert({ id: created.user.id, phone }, { onConflict: 'id' });
      if (upsertErr) throw upsertErr;
    }

    // 2. Mint a session via the magiclink generateLink workaround — see
    // file header. No email is actually sent; we just use the token.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkErr) throw linkErr;

    return new Response(
      JSON.stringify({
        email,
        token: linkData.properties.hashed_token,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500 },
    );
  }
});