// ═══════════════════════════════════════════════════════════
// ExoVet IO — Supabase Edge Function: create-checkout
// Crea una orden de pago en NexaPay y devuelve la URL
// ═══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No autorizado' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Usuario no encontrado' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: profile } = await supabase
      .from('perfiles')
      .select('email, nombre')
      .eq('id', user.id)
      .single()

    const NEXAPAY_API_KEY = Deno.env.get('NEXAPAY_API_KEY')
    const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://exovet.io'

    if (!NEXAPAY_API_KEY) {
      return new Response(JSON.stringify({ error: 'NexaPay no configurado' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const nexapayResp = await fetch('https://nexapay.one/api/payments/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NEXAPAY_API_KEY}`,
        'X-Api-Key': NEXAPAY_API_KEY,
      },
      body: JSON.stringify({
        amount: 59.00,
        currency: 'USD',
        description: 'ExoVet IO Premium — Acceso completo 24/7',
        customer_email: profile?.email ?? user.email,
        metadata: {
          user_id: user.id,
          plan: 'premium',
          source: 'exovet_io',
        },
        success_url: `${SITE_URL}?payment=success`,
        cancel_url: `${SITE_URL}?payment=cancelled`,
      })
    })

    const nexapayText = await nexapayResp.text()
    let nexapayData: any
    try {
      nexapayData = JSON.parse(nexapayText)
    } catch {
      console.error('NexaPay raw response:', nexapayText)
      return new Response(JSON.stringify({ error: 'Respuesta inválida de NexaPay' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!nexapayResp.ok) {
      console.error('NexaPay error:', nexapayData)
      return new Response(JSON.stringify({ error: 'Error NexaPay', details: nexapayData }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const orderId = nexapayData.order_id ?? nexapayData.id ?? nexapayData.payment_id
    const checkoutUrl = nexapayData.checkout_url ?? nexapayData.payment_url ?? nexapayData.url

    await supabase.from('pagos').insert({
      usuario_id: user.id,
      nexapay_order_id: orderId,
      monto: 59.00,
      plan: 'premium',
      status: 'pending',
    })

    return new Response(JSON.stringify({
      checkout_url: checkoutUrl,
      order_id: orderId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Error:', err)
    return new Response(JSON.stringify({ error: 'Error interno' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
