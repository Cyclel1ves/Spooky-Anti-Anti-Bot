const mineflayer = require('mineflayer')

function arg (name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env[name.toUpperCase()] ?? def)
}

const host = arg('host', '127.0.0.1')
const port = Number(arg('port', 25566))
const username = arg('username', 'Bot423')

const bot = mineflayer.createBot({
  host,
  port,
  username,
  version: '1.18.2',
  auth: 'offline',
  brand: 'vanilla',
  viewDistance: 'normal',
  enableTextFiltering: true
})

let flyingTicker = null
let mimicTimeouts = []
let mimicActive = false

function stopVanillaMimicTimers () {
  for (const t of mimicTimeouts) clearTimeout(t)
  mimicTimeouts = []
  if (flyingTicker !== null) {
    clearInterval(flyingTicker)
    flyingTicker = null
  }
  mimicActive = false
}

function startVanillaMimicTimers () {
  if (mimicActive) return
  stopVanillaMimicTimers()
  mimicActive = true

  const swingDelay = 430 + Math.floor(Math.random() * 70)
  const jitter = Math.floor(Math.random() * 30)
  const schedule = (fn, delay) => {
    const t = setTimeout(() => {
      mimicTimeouts = mimicTimeouts.filter((id) => id !== t)
      fn()
    }, delay)
    mimicTimeouts.push(t)
  }

  const sendArm = (hand) => {
    if (!bot?._client || bot._client.ended) return
    try {
      console.log(`[bot] vanilla-mimic arm -> ${hand}`)
      bot._client.write('arm_animation', { hand })
    } catch (err) {
      console.log('[bot] vanilla-mimic arm error', err)
    }
  }

  const sendFlying = () => {
    if (!bot?._client || bot._client.ended) return
    const onGround = !!bot.entity?.onGround
    try {
      console.log('[bot] vanilla-mimic flying ->', onGround)
      bot._client.write('flying', { onGround })
    } catch (err) {
      console.log('[bot] vanilla-mimic flying error', err)
    }
  }

  schedule(() => sendArm(0), 280 + jitter)
  schedule(() => sendArm(1), 320 + jitter)

  schedule(sendFlying, 420 + jitter)
  schedule(sendFlying, 480 + jitter)
  schedule(sendFlying, 540 + jitter)

  const flyingInterval = 760 + Math.floor(Math.random() * 80)
  flyingTicker = setInterval(sendFlying, flyingInterval)
}

bot.on('login', () => {
  console.log(`[bot] login ok`)
  setTimeout(() => {
    if (!mimicActive) startVanillaMimicTimers()
  }, 200)
})

bot.on('spawn', () => {
  console.log(`[bot] spawn`)
  startVanillaMimicTimers()
})

bot.on('message', (message) => {
  console.log(`[chat] ${message.toString()}`)
})

bot.on('kicked', (reason) => {
  console.log(`[bot] kicked: ${reason}`)
  stopVanillaMimicTimers()
})

bot.on('end', (reason) => {
  console.log(`[bot] end: ${reason}`)
  stopVanillaMimicTimers()
})

bot.on('error', (err) => {
  console.log(`[bot] error: ${err}`)
})
