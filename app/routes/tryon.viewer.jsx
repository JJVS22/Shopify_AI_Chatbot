/**
 * Simple 3D GLB viewer page for try-on results.
 * /tryon/viewer?glb=/api/tryon/results/3d/xxx.glb
 */
export async function loader({ request }) {
  const url = new URL(request.url);
  const glb = url.searchParams.get("glb") || "";
  const video = url.searchParams.get("video") || "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>3D Try-On Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f14; color: #eee; min-height: 100vh; }
    header { padding: 12px 16px; background: #1a1a24; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 16px; font-weight: 600; }
    header a { color: #8b83ff; font-size: 13px; }
    #c { width: 100%; height: calc(100vh - 52px); display: block; }
    .empty { padding: 40px; text-align: center; color: #888; }
    .hint { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,.6); padding: 8px 14px; border-radius: 20px; font-size: 12px; }
    video { max-width: 100%; max-height: 40vh; margin: 16px auto; display: block; border-radius: 8px; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <header>
    <h1>3D Try-On Viewer</h1>
    <a href="javascript:history.back()">← Back</a>
  </header>
  ${glb ? '<canvas id="c"></canvas><div class="hint">Drag to rotate · Scroll to zoom</div>' : '<div class="empty">No GLB model provided. Use ?glb=/api/tryon/results/3d/…</div>'}
  ${video ? `<video src="${escapeHtml(video)}" controls autoplay loop muted></video>` : ""}
  <script type="module">
    const glbUrl = ${JSON.stringify(glb)};
    if (!glbUrl) throw new Error('no glb');

    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight - 52);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f14);

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / (window.innerHeight - 52), 0.01, 100);
    camera.position.set(0, 1.2, 2.5);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0.8, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(3, 5, 2);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-3, 2, -2);
    scene.add(fill);

    const loader = new GLTFLoader();
    loader.load(glbUrl, (gltf) => {
      const root = gltf.scene;
      scene.add(root);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      root.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      camera.position.set(0, size.y * 0.3, maxDim * 2.2);
      controls.target.set(0, 0, 0);
      controls.update();
    }, undefined, (err) => {
      console.error(err);
      document.body.insertAdjacentHTML('beforeend', '<div class="empty">Failed to load GLB</div>');
    });

    function tick() {
      requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    }
    tick();

    window.addEventListener('resize', () => {
      const h = window.innerHeight - 52;
      camera.aspect = window.innerWidth / h;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, h);
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
