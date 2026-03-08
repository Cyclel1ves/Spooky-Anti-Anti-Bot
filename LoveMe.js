const mineflayer = require('mineflayer')

const PI = Math.PI
const TO_DEG = 180 / PI
const movementPackets = new Set([
  'position',
  'position_look',
  'look',
  'flying',
  'teleport_confirm'
])

function readArg (name) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env[name.toUpperCase()]
}

function stringArg (name, def) {
  const value = readArg(name)
  return value == null ? def : value
}

function numberArg (name, def) {
  const value = readArg(name)
  if (value == null || value === '') return def
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : def
}

function boolArg (name, def) {
  const value = readArg(name)
  if (value == null || value === '') return def
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return def
}

function viewDistanceArg (name, def) {
  const value = readArg(name)
  if (value == null || value === '') return def
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return value
}

function parseTraceFilter (value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )
}

function safeJson (value, maxLen) {
  let text
  try {
    text = JSON.stringify(value)
  } catch (err) {
    text = `<json error: ${err?.message || err}>`
  }

  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `...(+${text.length - maxLen})`
}

function formatCounts (counts) {
  return JSON.stringify(
    Object.fromEntries(
      [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    )
  )
}

function toNotchianYaw (yawRadians) {
  return Math.fround(180 - (yawRadians * TO_DEG))
}

function toNotchianPitch (pitchRadians) {
  return Math.fround(-(pitchRadians * TO_DEG))
}

function isBrandPacket (name, params) {
  return name === 'custom_payload' && params?.channel === 'minecraft:brand'
}

const host = stringArg('host', 'SpookyTime.net')
const port = numberArg('port', 25565)
const username = stringArg('username', 'SSS_Sosoezz')
const version = stringArg('version', '1.18.2')
const brand = stringArg('brand', 'vanilla')
const locale = stringArg('locale', 'ru_ru')
const viewDistance = viewDistanceArg('viewDistance', 32)
const enableTextFiltering = boolArg('enableTextFiltering', false)
const enableServerListing = boolArg('enableServerListing', true)
const checkTimeoutInterval = numberArg('checkTimeoutInterval', 120000)
const physicsEnabled = boolArg('physicsEnabled', true)

const mimicEnabled = boolArg('mimic', true)
const initialTeleportSpoofEnabled = boolArg('initialTeleportSpoof', mimicEnabled)
const initialSpoofGroundY = numberArg('initialSpoofGroundY', 65)
const initialSpoofOffsetX = numberArg('initialSpoofOffsetX', 1)
const initialSpoofOffsetZ = numberArg('initialSpoofOffsetZ', 1)
const earlySwingEnabled = boolArg('earlySwing', mimicEnabled)
const mountMimicEnabled = boolArg('mountMimic', mimicEnabled)
const resendSettingsOnSync = boolArg('resendSettingsOnSync', true)
const mountTickMs = numberArg('mountTickMs', 50)

const tracePackets = boolArg('tracePackets', false)
const tracePayload = boolArg('tracePayload', true)
const traceMaxLen = numberArg('traceMaxLen', 700)
const traceFilter = parseTraceFilter(stringArg(
  'traceFilter',
  'settings,custom_payload,position,teleport_confirm,position_look,look,flying,arm_animation,keep_alive,ping,pong,held_item_slot,animation,entity_effect,remove_entity_effect,block_change,multi_block_change,spawn_entity,entity_metadata,set_passengers,game_state_change,chat,set_title_text,set_title_subtitle,set_title_time,steer_vehicle,advancements,window_items'
))

const bot = mineflayer.createBot({
  host,
  port,
  username,
  version,
  auth: 'offline',
  brand,
  viewDistance,
  enableTextFiltering,
  enableServerListing,
  checkTimeoutInterval,
  physicsEnabled
})

if (bot.settings) {
  bot.settings.locale = locale
  bot.settings.viewDistance = viewDistance
  bot.settings.enableTextFiltering = enableTextFiltering
}

console.log(
  `[bot] connect ${host}:${port} user=${username} version=${version} ` +
  `locale=${locale} viewDistance=${viewDistance} physics=${physicsEnabled} mimic=${mimicEnabled} trace=${tracePackets}`
)

const packetCounts = {
  incoming: new Map(),
  outgoing: new Map()
}

function bumpCount (counts, name) {
  counts.set(name, (counts.get(name) || 0) + 1)
}

function shouldTracePacket (name) {
  return traceFilter.size === 0 || traceFilter.has(name)
}

function logPacket (dir, name, payload) {
  if (!tracePackets || !shouldTracePacket(name)) return
  const suffix = tracePayload ? ` ${safeJson(payload, traceMaxLen)}` : ''
  console.log(`[pkt:${dir}] ${name}${suffix}`)
}

const behavior = {
  settingsSent: false,
  queuedBrandPacket: null,
  firstServerTeleport: null,
  queuedTeleportConfirm: null,
  suppressMovementUntilSpoofComplete: false,
  initialTeleportSpoofScheduled: false,
  initialTeleportSpoofDone: !initialTeleportSpoofEnabled,
  earlySwingScheduled: false,
  settingsReplaySent: false,
  loginCount: 0,
  mountTicker: null,
  serverAnimationCount: 0
}

const rawWrite = bot._client.write.bind(bot._client)

function writeActual (name, params) {
  bumpCount(packetCounts.outgoing, name)
  logPacket('out', name, params)
  return rawWrite(name, params)
}

function getBrandChannelName () {
  if (bot.supportFeature('customChannelMCPrefixed')) return 'MC|Brand'
  if (bot.supportFeature('customChannelIdentifier')) return 'minecraft:brand'
  throw new Error('Unsupported brand channel name')
}

const brandChannel = getBrandChannelName()

function sendBrandPacket () {
  bot._client.writeChannel(brandChannel, brand)
}

function replaySettingsAndBrand (reason) {
  if (
    !resendSettingsOnSync ||
    behavior.settingsReplaySent ||
    bot._client.ended ||
    behavior.loginCount > 1
  ) {
    return
  }

  behavior.settingsReplaySent = true

  setTimeout(() => {
    if (bot._client.ended) return
    try {
      console.log(`[bot] replay settings+brand -> ${reason}`)
      bot.setSettings({
        locale,
        viewDistance,
        enableTextFiltering
      })
      sendBrandPacket()
    } catch (err) {
      console.log('[bot] replay settings+brand error', err)
    }
  }, 10)
}

function scheduleEarlySwing (reason) {
  if (!earlySwingEnabled || behavior.earlySwingScheduled || bot._client.ended) return
  behavior.earlySwingScheduled = true
  console.log(`[bot] early swing -> ${reason}`)

  const send = (hand, delay) => {
    setTimeout(() => {
      if (bot._client.ended) return
      try {
        writeActual('arm_animation', { hand })
      } catch (err) {
        console.log('[bot] early swing error', err)
      }
    }, delay)
  }

  send(0, 40)
  send(1, 80)
}

function stopMountMimic () {
  if (behavior.mountTicker !== null) {
    clearInterval(behavior.mountTicker)
    behavior.mountTicker = null
  }
}

function startMountMimic () {
  if (!mountMimicEnabled || behavior.mountTicker !== null) return

  const tick = () => {
    if (bot._client.ended || !bot.vehicle) {
      stopMountMimic()
      return
    }

    const yaw = Number.isFinite(bot.entity?.yaw) ? toNotchianYaw(bot.entity.yaw) : 0
    const pitch = Number.isFinite(bot.entity?.pitch) ? toNotchianPitch(bot.entity.pitch) : 0
    const onGround = !!bot.entity?.onGround

    try {
      writeActual('look', { yaw, pitch, onGround })
      writeActual('steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
    } catch (err) {
      console.log('[bot] mount mimic error', err)
      stopMountMimic()
    }
  }

  behavior.mountTicker = setInterval(tick, mountTickMs)
  tick()
}

function scheduleInitialTeleportSpoof () {
  if (
    !initialTeleportSpoofEnabled ||
    behavior.initialTeleportSpoofScheduled ||
    behavior.initialTeleportSpoofDone ||
    !behavior.firstServerTeleport ||
    !behavior.queuedTeleportConfirm
  ) {
    return
  }

  behavior.initialTeleportSpoofScheduled = true
  setTimeout(runInitialTeleportSpoof, 5)
}

function runInitialTeleportSpoof () {
  const actual = behavior.firstServerTeleport
  const confirm = behavior.queuedTeleportConfirm

  if (!actual || !confirm || bot._client.ended) {
    behavior.suppressMovementUntilSpoofComplete = false
    behavior.initialTeleportSpoofScheduled = false
    return
  }

  const spoof = {
    x: actual.x + initialSpoofOffsetX,
    y: initialSpoofGroundY,
    z: actual.z + initialSpoofOffsetZ,
    yaw: -180,
    pitch: 0,
    onGround: false
  }

  const fallOffsets = [
    0.0784000015258789,
    0.23363200604248047,
    0.4641593749554364,
    0.76847620241298
  ]

  try {
    writeActual('position_look', spoof)

    for (const offset of fallOffsets) {
      writeActual('position', {
        x: spoof.x,
        y: initialSpoofGroundY - offset,
        z: spoof.z,
        onGround: false
      })
    }

    writeActual('teleport_confirm', confirm)
    writeActual('position_look', {
      x: actual.x,
      y: actual.y,
      z: actual.z,
      yaw: actual.yaw,
      pitch: actual.pitch,
      onGround: false
    })
    writeActual('position_look', {
      x: actual.x,
      y: actual.y,
      z: actual.z,
      yaw: actual.yaw,
      pitch: actual.pitch,
      onGround: false
    })

    console.log('[bot] initial teleport spoof applied')
  } catch (err) {
    console.log('[bot] initial teleport spoof error', err)
  } finally {
    behavior.queuedTeleportConfirm = null
    behavior.suppressMovementUntilSpoofComplete = false
    behavior.initialTeleportSpoofScheduled = false
    behavior.initialTeleportSpoofDone = true
  }
}

bot._client.write = (name, params) => {
  if (name === 'settings' && params) {
    params.locale = locale
    if (typeof viewDistance === 'number') params.viewDistance = viewDistance
    params.enableTextFiltering = enableTextFiltering
    params.enableServerListing = enableServerListing
  }

  if (isBrandPacket(name, params) && !behavior.settingsSent) {
    behavior.queuedBrandPacket = params
    return
  }

  if (!behavior.initialTeleportSpoofDone && name === 'held_item_slot' && params?.slotId === 0) {
    return
  }

  if (name === 'settings' && !behavior.settingsSent) {
    behavior.settingsSent = true
    const result = writeActual(name, params)
    if (behavior.queuedBrandPacket) {
      const packet = behavior.queuedBrandPacket
      behavior.queuedBrandPacket = null
      writeActual('custom_payload', packet)
    }
    return result
  }

  if (behavior.suppressMovementUntilSpoofComplete && !behavior.initialTeleportSpoofDone) {
    if (
      name === 'teleport_confirm' &&
      params?.teleportId === behavior.firstServerTeleport?.teleportId
    ) {
      behavior.queuedTeleportConfirm = params
      scheduleInitialTeleportSpoof()
      return
    }

    if (movementPackets.has(name)) {
      return
    }
  }

  return writeActual(name, params)
}

bot._client.on('packet', (data, meta) => {
  bumpCount(packetCounts.incoming, meta.name)
  logPacket('in', meta.name, data)

  if (
    meta.name === 'position' &&
    !behavior.firstServerTeleport &&
    initialTeleportSpoofEnabled &&
    typeof data?.teleportId !== 'undefined'
  ) {
    behavior.firstServerTeleport = {
      x: data.x,
      y: data.y,
      z: data.z,
      yaw: data.yaw,
      pitch: data.pitch,
      teleportId: data.teleportId
    }
    behavior.suppressMovementUntilSpoofComplete = true
  }

  if (meta.name === 'animation') {
    behavior.serverAnimationCount += 1
    if (behavior.serverAnimationCount === 2) {
      scheduleEarlySwing('server-animation')
    }
  }

  if (meta.name === 'respawn' || meta.name === 'window_items') {
    stopMountMimic()
  }

  if ((meta.name === 'advancements' || meta.name === 'window_items') && !behavior.settingsReplaySent) {
    replaySettingsAndBrand(meta.name)
  }
})

bot.on('forcedMove', () => {
  if (!tracePackets) return
  const pos = bot.entity?.position
  if (!pos) return
  console.log(
    `[event] forcedMove x=${pos.x.toFixed(3)} y=${pos.y.toFixed(3)} z=${pos.z.toFixed(3)} ` +
    `yaw=${bot.entity.yaw.toFixed(3)} pitch=${bot.entity.pitch.toFixed(3)}`
  )
})

function dumpPacketCounts () {
  if (!tracePackets) return
  console.log(`[pkt:counts:in] ${formatCounts(packetCounts.incoming)}`)
  console.log(`[pkt:counts:out] ${formatCounts(packetCounts.outgoing)}`)
}

bot.on('login', () => {
  behavior.loginCount += 1
  if (behavior.loginCount > 1) stopMountMimic()
  console.log('[bot] login ok')
})

bot.on('spawn', () => {
  const pos = bot.entity?.position
  console.log(`[bot] spawn${pos ? ` ${pos}` : ''}`)
})

bot.on('mount', () => {
  console.log('[bot] mount')
  startMountMimic()
})

bot.on('dismount', () => {
  console.log('[bot] dismount')
  stopMountMimic()
})

bot.on('message', (message) => {
  console.log(`[chat] ${message.toString()}`)
})

bot.on('kicked', (reason) => {
  console.log(`[bot] kicked: ${reason}`)
  stopMountMimic()
  dumpPacketCounts()
})

bot.on('end', (reason) => {
  console.log(`[bot] end: ${reason}`)
  stopMountMimic()
  dumpPacketCounts()
})

bot.on('error', (err) => {
  console.log(`[bot] error: ${err}`)
})
