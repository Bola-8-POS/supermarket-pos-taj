import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { corsHeaders } from "../_shared/cors.ts"

// supabase.functions.invoke() sends `authorization` + `apikey` + `x-client-info`, so a
// browser preflight needs them allowed explicitly — without this the call fails CORS in
// every web build (useServerTimeDrift then silently disables clock-drift detection).
//
// This is the sole unauthenticated function (verify_jwt = false) and the
// sole one answering GET, POST and OPTIONS — its only real caller invokes it
// through supabase.functions.invoke, which sends POST by default even for a
// body-less "read" call, so a GET-only guard would 405 the app's own call.
function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: methodsHeader(req) })
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...methodsHeader(req) },
    })
  }
  return new Response(
    JSON.stringify({ serverTime: new Date().toISOString() }),
    {
      headers: {
        "Content-Type": "application/json",
        ...methodsHeader(req),
      },
    }
  )
})
