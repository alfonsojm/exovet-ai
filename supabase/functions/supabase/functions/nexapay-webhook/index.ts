// ═══════════════════════════════════════════════════════════
// ExoVet IO — Supabase Edge Function: nexapay-webhook
// Recibe eventos de NexaPay y activa Premium automáticamente
// ═══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const WEBHOOK_SECRET = Deno.env.get('NEXAPAY_WEBHOOK_SECRET')
    const rawBody = await req.text()

    if (WEBHOOK_SECRET) {
      const signature = req.headers.get('x-nexapay-signature') ?? ''
      const timestamp  = req.headers.get('x-nexapay-timestamp') ?? ''

      if (signature && timestamp) {
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(WEBHOOK_SECRET),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        )
        const payload = `${timestamp}.${rawBody}`
        const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
        const computedSig = 'sha256=' + Array.from(new Uint8Array(sigBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')

        if (computedSig !== signature) {
          console.error('Firma inválida del webhook')
          return new Response('Unauthorized', { status: 401 })
        }
      }
    }

    const event = JSON.parse(rawBody)
    const eventType = (event.type ?? event.event ?? event.status ?? '').toLowerCase()
    console.log('NexaPay event:', eventType, '| Order:', event.order_id ?? event.id)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    if (['payment.completed','payment_completed','completed','paid','order.paid'].includes(eventType)) {
      await handleSuccess(supabase, event)
    } else if (['payment.failed','payment_failed','failed'].includes(eventType)) {
      await handleFailed(supabase, event)
    } else if (['payment.refunded','refunded','order.refunded'].includes(eventType)) {
      await handleRefund(supabase, event)
    } else if (['subscription.cancelled','cancelled','order.cancelled'].includes(eventType)) {
      await handleCancelled(supabase, event)
    } else {
      console.log('Evento no manejado:', eventType)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
})

async function handleSuccess(supabase: any, event: any) {
  const orderId   = event.order_id ?? event.id ?? event.payment_id
  const userId    = event.metadata?.user_id ?? event.data?.metadata?.user_id
  const amount    = event.amount ?? 59
  const crypto    = event.cryptocurrency ?? event.crypto_type ?? null
  const cryptoAmt = event.crypto_amount ?? null

  console.log(`✅ PAGO EXITOSO — Order: ${orderId} | User: ${userId}`)

  let resolvedUserId = userId

  if (!resolvedUserId) {
    const { data: pago } = await supabase
      .from('pagos')
      .select('usuario_id')
      .eq('nexapay_order_id', orderId)
      .single()
    resolvedUserId = pago?.usuario_id
  }

  if (!resolvedUserId) {
    console.error('No se pudo identificar al usuario para order:', orderId)
    return
  }

  const vence = new Date()
  vence.setDate(vence.getDate() + 30)

  await supabase.from('perfiles').update({
    plan: 'premium',
    suscripcion_activa: true,
    suscripcion_vence: vence.toISOString(),
  }).eq('id', resolvedUserId)

  await supabase.from('pagos').upsert({
    usuario_id: resolvedUserId,
    nexapay_order_id: orderId,
    monto: amount,
    plan: 'premium',
    status: 'completed',
    crypto_tipo: crypto,
    crypto_recibido: cryptoAmt,
  }, { onConflict: 'nexapay_order_id' })

  console.log(`✅ Usuario ${resolvedUserId} → Premium hasta ${vence.toISOString()}`)
}

async function handleFailed(supabase: any, event: any) {
  const orderId = event.order_id ?? event.id
  await supabase.from('pagos').update({ status: 'failed' }).eq('nexapay_order_id', orderId)
  console.log(`❌ Pago fallido — Order: ${orderId}`)
}

async function handleRefund(supabase: any, event: any) {
  const orderId = event.order_id ?? event.id
  const userId  = event.metadata?.user_id ?? null
  await supabase.from('pagos').update({ status: 'refunded' }).eq('nexapay_order_id', orderId)
  if (userId) await supabase.from('perfiles').update({ plan: 'free', suscripcion_activa: false }).eq('id', userId)
  console.log(`💰 Reembolso — Order: ${orderId}`)
}

async function handleCancelled(supabase: any, event: any) {
  const orderId = event.order_id ?? event.id
  const userId  = event.metadata?.user_id ?? null
  await supabase.from('pagos').update({ status: 'cancelled' }).eq('nexapay_order_id', orderId)
  if (userId) await supabase.from('perfiles').update({ plan: 'free', suscripcion_activa: false }).eq('id', userId)
  console.log(`🚫 Cancelado — Order: ${orderId}`)
}
