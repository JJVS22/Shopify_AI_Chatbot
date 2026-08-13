import Replicate from 'replicate'
import { writeFile } from 'node:fs/promises'
import dotenv from 'dotenv'
dotenv.config()

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
  userAgent: 'https://www.npmjs.com/package/create-replicate'
})

const output = await replicate.run(
  "firtoz/trellis:e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c",
  {
    input: {
      seed: 0,
      images: ["https://replicate.delivery/pbxt/Pc4t8nXRQQwqvcNSZubpcInWgxhkHm4pbNKN2b7bqSa9j4Uv/sexybr.jpeg"],
      texture_size: 2048,
      mesh_simplify: 0.9,
      generate_color: true,
      generate_model: true,
      randomize_seed: true,
      generate_normal: false,
      save_gaussian_ply: true,
      ss_sampling_steps: 38,
      slat_sampling_steps: 12,
      return_no_background: false,
      ss_guidance_strength: 7.5,
      slat_guidance_strength: 3
    }
  }
)

if (output.model_file) {
  await writeFile('model.glb', output.model_file)
  console.log('Saved model.glb')
}
if (output.color_video) {
  await writeFile('color_video.mp4', output.color_video)
  console.log('Saved color_video.mp4')
}
if (output.gaussian_ply) {
  await writeFile('gaussian.ply', output.gaussian_ply)
  console.log('Saved gaussian.ply')
}