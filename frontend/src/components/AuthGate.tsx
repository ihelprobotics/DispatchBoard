"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { Board } from "./Board";

export function AuthGate({ tvMode }: { tvMode: boolean }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      setSignedIn(Boolean(data.session));
      setLoading(false);
    };
    init();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleLogin = async () => {
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) {
      setMessage(error.message || "Sign-in failed. Check the email and try again.");
      return;
    }
    setMessage("Check your email for the magic link.");
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return <p className="p-6 text-sm text-ink/60">Loading...</p>;
  }

  if (!signedIn) {
    return (
      <div className="min-h-screen bg-paper px-6 py-10">
        <div className="mx-auto w-full max-w-md rounded-3xl border border-ink/10 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold">DispatchBoard</h1>
          <p className="mt-2 text-sm text-ink/60">Sign in to access the board.</p>
          <label className="mt-6 block text-sm font-semibold text-ink/70">
            Email
            <input
              className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              type="email"
              autoComplete="email"
            />
          </label>
          <button
            className="mt-4 w-full rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white"
            onClick={handleLogin}
          >
            Send magic link
          </button>
          {message ? <p className="mt-3 text-xs text-ink/60">{message}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-end px-6 pt-4">
        <button className="rounded-xl border border-ink/10 px-3 py-2 text-xs font-semibold" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      <Board tvMode={tvMode} />
    </div>
  );
}
