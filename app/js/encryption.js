var Crypto = require("iota.crypto.js")

function trinarySum(a, b) {
  const result = a + b
  return result == 2 ? -1 : result == -2 ? 1 : result
}

function increment(subseed, count) {
  let index = count == null || count < 1 ? 1 : count
  while (index-- > 0) {
    for (let j = 0; j < 243; j++) {
      if (++subseed[j] > 1) {
        subseed[j] = -1
      } else {
        break
      }
    }
  }
  return subseed
}

function hash(...keys) {
  const curl = new Crypto.curl()
  const key = new Int32Array(243)
  curl.initialize()
  keys.map(k => curl.absorb(k, 0, k.length))
  curl.squeeze(key, 0, 243)
  return key
}

function encrypt(message, key, salt) {
  const curl = new Crypto.curl()
  curl.initialize()
  curl.absorb(Crypto.converter.trits(key), 0, key.length)
  if (salt != null) {
    curl.absorb(Crypto.converter.trits(salt), 0, salt.length)
  }
  const length = message.length * 3
  const outTrits = new Int32Array(length)
  const intermedaiteKey = new Int32Array(curl.HASH_LENGTH)
  return message
    .match(/.{1,81}/g)
    .map(m => {
      curl.squeeze(intermedaiteKey, 0, curl.HASH_LENGTH)
      const out = Crypto.converter.trytes(
        Crypto.converter
          .trits(m)
          .map((t, i) => trinarySum(t, intermedaiteKey[i]))
      )
      return out
    })
    .join("")
}

function decrypt(message, key, salt) {
  const curl = new Crypto.curl()
  curl.initialize()
  curl.absorb(Crypto.converter.trits(key), 0, key.length)
  if (salt != null) {
    curl.absorb(Crypto.converter.trits(salt), 0, salt.length)
  }
  const messageTrits = Crypto.converter.trits(message)
  const length = messageTrits.length
  const plainTrits = new Int32Array(length)
  const intermedaiteKey = new Int32Array(curl.HASH_LENGTH)
  return message
    .match(/.{1,81}/g)
    .map(m => {
      curl.squeeze(intermedaiteKey, 0, curl.HASH_LENGTH)
      const out = Crypto.converter.trytes(
        Crypto.converter
          .trits(m)
          .map((t, i) => trinarySum(t, -intermedaiteKey[i]))
      )
      return out
    })
    .join("")
}

module.exports = {
  encrypt,
  decrypt,
  increment,
  hash
}