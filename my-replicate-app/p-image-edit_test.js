import Replicate from 'replicate'
import process from 'node:process'
import dotenv from 'dotenv'
dotenv.config()

/**
 * Schema-discovery helper for prunaai/p-image-edit.
 * Run:  node p-image-edit_test.js [personImageUrl] [productImageUrl]
 * It tries several input shapes and prints which one works.
 */

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
  userAgent: 'shop-chat-agent/p-image-edit-test'
})

const PERSON = process.argv[2] || 'https://replicate.delivery/pbxt/Pc4t8nXRQQwqvcNSZubpcInWgxhkHm4pbNKN2b7bqSa9j4Uv/sexybr.jpeg'
const PRODUCT = process.argv[3] || PERSON

const prompt = 'Show the person holding the product from the second image in their hands. Keep identity, pose, background. Realistic.'

const schemas = [
  { images: [PERSON, PRODUCT], prompt, aspect_ratio: 'match_input_image' },
  { images: [PERSON, PRODUCT], prompt },
  { image: PERSON, image_2: PRODUCT, prompt },
  { image: PERSON, reference_image: PRODUCT, prompt },
  { image_1: PERSON, image_2: PRODUCT, prompt },
  { image: PERSON, prompt, style_image: PRODUCT },
]

for (const [i, input] of schemas.entries()) {
  const keys = Object.keys(input).join(', ')
  console.log(`\n--- Attempt ${i + 1} schema: [${keys}] ---`)
  try {
    const output = await replicate.run('prunaai/p-image-edit', { input })
    if (typeof output === 'string') {
      console.log('SUCCESS (string):', output.slice(0, 300))
    } else if (Array.isArray(output)) {
      console.log('SUCCESS (array len ' + output.length + '):', JSON.stringify(output[0]).slice(0, 300))
    } else {
      console.log('SUCCESS (object keys):', Object.keys(output))
      console.log('sample:', JSON.stringify(output).slice(0, 300))
    }
    break
  } catch (e) {
    console.log('FAILED:', e.message)
  }
}
