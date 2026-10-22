// Halo — configurateur de montures (modèle Sketchfab "Glasses 08" réel, plus
// de géométrie procédurale) + essai de vision œil par œil (flou DOM/CSS par
// plan de profondeur) + verre progressif (clip-path/mask qui suit la souris).
// La logique de flou/netteté est portée depuis le prototype du handoff
// (design_handoff_halo_site/Halo - Site vitrine.dc.html) quasiment telle
// quelle, en remplaçant l'état React par de simples data-attributes DOM.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

const MODEL_URL = "/glasses_08.glb";
// Noms de matériaux tels qu'exportés par Sketchfab (export générique, sans
// noms de mesh sémantiques — identifiés par inspection des bounding box et
// des tailles d'instance, cf. memory du projet).
const LENS_MATERIAL_NAME = "000_Glass";
const NOSE_MATERIAL_NAME = "002_Nose";

// Le modèle est réutilisé par deux viewers (hero + configurateur) : un seul
// fetch/parse du GLB, partagé. Chaque viewer clone ensuite les géométries en
// espace monde normalisé à partir de cette racine commune (jamais mutée).
let glassesRootPromise: Promise<THREE.Object3D> | null = null;
function loadGlassesRoot(): Promise<THREE.Object3D> {
  if (!glassesRootPromise) {
    glassesRootPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      return gltf.scene;
    });
  }
  return glassesRootPromise;
}

interface ColorDef {
  id: string;
  label: string;
  hex: number;
  clear?: boolean;
}
interface MaterialDef {
  id: string;
  label: string;
  price: number;
}
interface LensDef {
  id: string;
  label: string;
  hex: number;
  op: number;
  add: number;
  irid?: boolean;
}

const COLORS: ColorDef[] = [
  { id: "miel", label: "Écaille miel", hex: 0xa86a38 },
  { id: "encre", label: "Encre", hex: 0x2a2622 },
  { id: "sauge", label: "Sauge", hex: 0x8b977c },
  { id: "terre", label: "Terre cuite", hex: 0xa9573c },
  { id: "cristal", label: "Cristal rosé", hex: 0xecd6c8, clear: true },
];
const MATERIALS: MaterialDef[] = [
  { id: "poli", label: "Acétate poli", price: 390 },
  { id: "mat", label: "Acétate mat", price: 390 },
  { id: "titane", label: "Titane", price: 520 },
];
const LENSES: LensDef[] = [
  { id: "clair", label: "clair", hex: 0xffffff, op: 0.1, add: 0 },
  { id: "ambre", label: "ambre doux", hex: 0xd99a4e, op: 0.42, add: 60 },
  { id: "fume", label: "gris fumé", hex: 0x4a4642, op: 0.62, add: 60 },
  { id: "bleu", label: "lumière bleue", hex: 0xf3e9c8, op: 0.2, add: 40, irid: true },
];

class GlassesConfigurator {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private group: THREE.Group;
  private frameMaterials: THREE.MeshPhysicalMaterial[] = [];
  private lensMaterials: THREE.MeshPhysicalMaterial[] = [];
  private host: HTMLElement;
  private rot = { y: -0.6, x: 0.14, ty: -0.6, tx: 0.14 };
  private lastInteraction = -1e9;
  private dragging: { x: number; y: number; ry: number; rx: number } | null = null;
  private raf = 0;
  private running = false;
  private baseDistance: number;

  constructor(host: HTMLElement, cameraDistance = 4.2) {
    this.host = host;
    this.baseDistance = cameraDistance;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block;touch-action:pan-y;cursor:grab";
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 0.15, this.baseDistance);
    this.camera.lookAt(0, 0, 0);

    this.setupLighting();

    this.group = new THREE.Group();
    this.group.position.y = 0.08;
    this.scene.add(this.group);

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(host);
    this.resize();

    this.bindPointer();
  }

  // Charge le modèle Sketchfab (export générique, sans hiérarchie/échelle à
  // préserver) et "bake" chaque mesh en espace monde normalisé — même
  // précaution que sur qc35/Ancre : appliquer la matrice monde une fois à la
  // géométrie plutôt que de garder une hiérarchie de transforms à gérer.
  async load(sizeMultiplier = 1) {
    const root = await loadGlassesRoot();

    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const scale = sizeMultiplier / size.x; // largeur normalisée à sizeMultiplier unité(s)

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const srcMat = mesh.material as THREE.MeshStandardMaterial | undefined;
      const name = srcMat?.name ?? "";

      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      geo.translate(-center.x, -center.y, -center.z);
      geo.scale(scale, scale, scale);

      let mat: THREE.MeshPhysicalMaterial;
      if (name === LENS_MATERIAL_NAME) {
        mat = new THREE.MeshPhysicalMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
        this.lensMaterials.push(mat);
      } else if (name === NOSE_MATERIAL_NAME) {
        // Plaquettes de nez : silicone clair, indépendant de la teinte choisie.
        mat = new THREE.MeshPhysicalMaterial({
          color: 0xf5f0ea,
          transparent: true,
          opacity: 0.35,
          roughness: 0.25,
          clearcoat: 1,
          side: THREE.DoubleSide,
        });
      } else {
        mat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
        if (srcMat?.map) mat.map = srcMat.map;
        if (srcMat?.normalMap) mat.normalMap = srcMat.normalMap;
        if (srcMat?.roughnessMap) mat.roughnessMap = srcMat.roughnessMap;
        if (srcMat?.metalnessMap) mat.metalnessMap = srcMat.metalnessMap;
        this.frameMaterials.push(mat);
      }
      this.group.add(new THREE.Mesh(geo, mat));
    });
  }

  private setupLighting() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xf1e8dc);
    const addLight = (w: number, h: number, pos: [number, number, number], color: number, intensity: number) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
      );
      mesh.position.set(...pos);
      mesh.lookAt(0, 0, 0);
      envScene.add(mesh);
    };
    addLight(6, 3, [0, 5, 2], 0xfff4e6, 3);
    addLight(3, 4, [-5, 1, 2], 0xffffff, 2.2);
    addLight(3, 3, [5, 0.5, -2], 0xffe0c4, 1.4);
    addLight(8, 2, [0, -4, 0], 0xd9c8b4, 0.7);
    this.scene.environment = pm.fromScene(envScene, 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xfff8f0, 0xd8c6b0, 0.7));
    const directional = new THREE.DirectionalLight(0xfff1e0, 1.3);
    directional.position.set(2, 3, 3);
    this.scene.add(directional);
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      this.dragging = { x: e.clientX, y: e.clientY, ry: this.rot.ty, rx: this.rot.tx };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.rot.ty = this.dragging.ry + (e.clientX - this.dragging.x) * 0.008;
      this.rot.tx = Math.max(-0.5, Math.min(0.6, this.dragging.rx + (e.clientY - this.dragging.y) * 0.005));
      this.lastInteraction = performance.now();
    });
    const release = () => {
      this.dragging = null;
      el.style.cursor = "grab";
      this.lastInteraction = performance.now();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.position.z = w / h < 1 ? ((this.baseDistance / (w / h)) * 0.9) : this.baseDistance;
    this.camera.updateProjectionMatrix();
  }

  applyMaterials(colorId: string, materialId: string, lensId: string) {
    const col = COLORS.find((c) => c.id === colorId)!;
    const material = MATERIALS.find((m) => m.id === materialId)!;
    const lens = LENSES.find((l) => l.id === lensId)!;
    const c = new THREE.Color(col.hex);

    let metalness = 0;
    let roughness = 0.2;
    let clearcoat = 1;
    const clearcoatRoughness = 0.08;
    let envMapIntensity = 1;
    if (material.id === "mat") {
      roughness = 0.62;
      clearcoat = 0;
    }
    if (material.id === "titane") {
      metalness = 1;
      roughness = 0.3;
      clearcoat = 0.3;
      c.lerp(new THREE.Color(0xc9bfb2), 0.35);
      envMapIntensity = 1.4;
    }
    const transparent = !!col.clear && material.id !== "titane";

    this.frameMaterials.forEach((m) => {
      m.color.copy(c);
      m.metalness = metalness;
      m.roughness = roughness;
      m.clearcoat = clearcoat;
      m.clearcoatRoughness = clearcoatRoughness;
      m.envMapIntensity = envMapIntensity;
      m.transparent = transparent;
      m.opacity = transparent ? 0.62 : 1;
      m.needsUpdate = true;
    });

    this.lensMaterials.forEach((m) => {
      m.color.set(lens.hex);
      m.opacity = lens.op;
      m.roughness = 0.03;
      m.metalness = 0;
      m.clearcoat = 1;
      m.envMapIntensity = 1.6;
      m.iridescence = lens.irid ? 0.7 : 0;
      m.iridescenceIOR = 1.6;
      m.needsUpdate = true;
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastInteraction = performance.now();
    const tick = (t: number) => {
      if (!this.running) return;
      if (!this.dragging && t - this.lastInteraction > 2500) this.rot.ty += 0.0018;
      this.rot.y += (this.rot.ty - this.rot.y) * 0.08;
      this.rot.x += (this.rot.tx - this.rot.x) * 0.08;
      this.group.rotation.set(this.rot.x, this.rot.y, 0);
      this.group.position.y = 0.08 + Math.sin(t / 1700) * 0.02;
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

function formatAcuity(v: number): string {
  return `${v}/10`;
}

async function initConfigurator() {
  const host = document.getElementById("glassesHost");
  if (!host) return;

  const configurator = new GlassesConfigurator(host);
  const state = { color: "miel", material: "poli", lens: "clair" };

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) configurator.start();
        else configurator.stop();
      }
    },
    { threshold: 0.01 },
  );
  io.observe(host);

  const colorLabelEl = document.getElementById("colorLabel");
  const summaryEl = document.getElementById("configSummary");
  const priceEl = document.getElementById("configPrice");
  const viewerLabelEl = document.querySelector<HTMLElement>(".viewer-label");

  function setActive(groupSelector: string, activeEl: HTMLElement) {
    document.querySelectorAll<HTMLElement>(groupSelector).forEach((el) => {
      el.setAttribute("data-active", el === activeEl ? "true" : "false");
    });
  }

  function refreshDerived() {
    const color = COLORS.find((c) => c.id === state.color)!;
    const material = MATERIALS.find((m) => m.id === state.material)!;
    const lens = LENSES.find((l) => l.id === state.lens)!;

    if (colorLabelEl) colorLabelEl.textContent = color.label;
    if (summaryEl) summaryEl.textContent = `Iris · ${color.label} · ${material.label} · verres ${lens.label}`;
    if (priceEl) priceEl.textContent = `${material.price + lens.add} €`;
  }

  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.color = btn.dataset.color!;
      setActive("[data-color]", btn);
      configurator.applyMaterials(state.color, state.material, state.lens);
      refreshDerived();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-material]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.material = btn.dataset.material!;
      setActive("[data-material]", btn);
      configurator.applyMaterials(state.color, state.material, state.lens);
      refreshDerived();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-lens]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.lens = btn.dataset.lens!;
      setActive("[data-lens]", btn);
      configurator.applyMaterials(state.color, state.material, state.lens);
      refreshDerived();
    });
  });

  refreshDerived();

  if (viewerLabelEl) viewerLabelEl.textContent = "Chargement du modèle…";
  await configurator.load();
  configurator.applyMaterials(state.color, state.material, state.lens);
  if (viewerLabelEl) viewerLabelEl.textContent = "Vue 360° · glisser pour tourner";
}

type EyeType = "presbytie" | "astigmate";
const PLANE_BLUR: Record<"far" | "mid" | "near", number> = { far: 1.6, mid: 1.0, near: 0.5 };

function initVision() {
  const eyeIds = ["od", "og"];
  const eyeType: Record<string, EyeType> = { od: "presbytie", og: "presbytie" };

  // Pas de prescription cachée à deviner : le curseur EST l'acuité de l'œil
  // (ce que le visiteur annonce, "je vois 8 à droite"), et le flou en
  // découle directement — net à 10/10, de plus en plus flou en dessous.
  function updateEye(id: string) {
    const slider = document.getElementById(`eyeSlider-${id}`) as HTMLInputElement | null;
    if (!slider) return;
    const value = parseFloat(slider.value);
    const deficit = 10 - value;
    const sharpness = Math.round(value * 10);
    const isSharp = deficit === 0;
    const astigmate = eyeType[id] === "astigmate";

    (Object.keys(PLANE_BLUR) as Array<keyof typeof PLANE_BLUR>).forEach((plane) => {
      const amount = deficit * PLANE_BLUR[plane];
      document.querySelectorAll<HTMLElement>(`[data-plane="${plane}"][data-eye="${id}"]`).forEach((el) => {
        if (astigmate) {
          // L'astigmatisme étire le flou dans un axe (contrairement au flou
          // rond uniforme de la myopie/presbytie) : rayon horizontal très
          // supérieur au vertical, via un filtre SVG plutôt que `blur()`
          // CSS qui ne sait produire qu'un flou gaussien symétrique.
          const blurEl = document.getElementById(`astig-${id}-${plane}-blur`);
          blurEl?.setAttribute("stdDeviation", `${(amount * 1.9).toFixed(2)} ${(amount * 0.3).toFixed(2)}`);
          el.style.filter = `url(#astig-${id}-${plane})`;
        } else {
          el.style.filter = `blur(${amount.toFixed(2)}px)`;
        }
      });
    });

    const valueEl = document.getElementById(`eyeValue-${id}`);
    if (valueEl) valueEl.textContent = formatAcuity(value);

    const barEl = document.getElementById(`eyeBar-${id}`);
    if (barEl) barEl.style.width = `${sharpness}%`;

    const textEl = document.getElementById(`eyeText-${id}`);
    if (textEl) {
      textEl.textContent = isSharp ? "Mise au point" : `Netteté ${sharpness} %`;
      textEl.classList.toggle("is-sharp", isSharp);
    }
  }

  eyeIds.forEach((id) => {
    const slider = document.getElementById(`eyeSlider-${id}`) as HTMLInputElement | null;
    slider?.addEventListener("input", () => updateEye(id));

    document.querySelectorAll<HTMLButtonElement>(`#eyeType-${id} .eye-type-pill`).forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type as EyeType;
        eyeType[id] = type;
        document.querySelectorAll<HTMLButtonElement>(`#eyeType-${id} .eye-type-pill`).forEach((b) => {
          b.dataset.active = String(b === btn);
        });
        updateEye(id);
      });
    });

    updateEye(id);
  });

  document.getElementById("resetBtn")?.addEventListener("click", () => {
    eyeIds.forEach((id) => {
      const slider = document.getElementById(`eyeSlider-${id}`) as HTMLInputElement | null;
      if (slider) slider.value = "10";
      updateEye(id);
    });
  });
}

function initProgressiveLens() {
  const scene = document.getElementById("progLens");
  const sharpLayer = document.getElementById("progLayerSharp");
  const lensCircle = document.getElementById("lensCircle");
  if (!scene || !sharpLayer || !lensCircle) return;

  function moveTo(xPct: number) {
    const x = Math.round(xPct * 2) / 2;
    sharpLayer!.style.clipPath = `ellipse(18% 32% at ${x}% 50%)`;
    const mask = `radial-gradient(ellipse 16% 20% at ${x}% 26%, #000 55%, transparent 100%), radial-gradient(ellipse 5% 14% at ${x}% 50%, #000 45%, transparent 100%), radial-gradient(ellipse 10% 13% at ${x}% 74%, #000 50%, transparent 100%)`;
    sharpLayer!.style.maskImage = mask;
    (sharpLayer as HTMLElement).style.setProperty("-webkit-mask-image", mask);
    lensCircle!.style.left = `${x - 18}%`;
  }

  scene.addEventListener("pointermove", (e) => {
    const rect = scene.getBoundingClientRect();
    const x = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
    moveTo(x);
  });

  moveTo(32);
}

// Curseur "lentille" + boutons magnétiques — desktop uniquement (pointer:fine),
// et seulement si l'utilisateur n'a pas demandé moins d'animation : le curseur
// masque le curseur natif, donc on revient dessus plutôt que de l'imposer.
const MAGNETIC_SELECTOR = ".btn, .opt-pill, .swatch";
const CURSOR_TARGET_SELECTOR = "a[href], button, input[type=range]";

function initCursor() {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const hideNativeCursor = document.createElement("style");
  hideNativeCursor.textContent = "html, body, body * { cursor: none !important; }";
  document.head.appendChild(hideNativeCursor);

  const ring = document.createElement("div");
  ring.style.cssText =
    "position:fixed;left:0;top:0;pointer-events:none;z-index:9999;width:44px;height:44px;margin:-22px 0 0 -22px;" +
    "border-radius:22px;border:1px solid rgba(178,95,62,.55);background:rgba(255,255,255,.08);" +
    "backdrop-filter:blur(1.5px) saturate(1.3);-webkit-backdrop-filter:blur(1.5px) saturate(1.3);" +
    "box-shadow:inset 0 1px 1px rgba(255,255,255,.8),0 10px 30px -12px rgba(140,90,50,.35);" +
    "transition:width .35s cubic-bezier(.2,.8,.2,1),height .35s cubic-bezier(.2,.8,.2,1),margin .35s cubic-bezier(.2,.8,.2,1),border-radius .35s cubic-bezier(.2,.8,.2,1),background .3s,border-color .3s,opacity .3s;" +
    "display:flex;align-items:center;justify-content:center;font:400 10px/1 'DM Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:#b25f3e;opacity:0";
  const glint = document.createElement("div");
  glint.style.cssText =
    "position:absolute;left:18%;top:12%;width:34%;height:20%;border-radius:50%;background:radial-gradient(ellipse,rgba(255,255,255,.95),rgba(255,255,255,0) 70%);transform:rotate(-28deg)";
  ring.appendChild(glint);
  const label = document.createElement("span");
  ring.appendChild(label);
  document.body.appendChild(ring);

  const dot = document.createElement("div");
  dot.style.cssText =
    "position:fixed;left:0;top:0;pointer-events:none;z-index:9999;width:6px;height:6px;margin:-3px 0 0 -3px;" +
    "border-radius:50%;background:#b25f3e;transition:opacity .25s,transform .25s;opacity:0";
  document.body.appendChild(dot);

  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  const ringPos = { x: mouse.x, y: mouse.y };
  let target: HTMLElement | null = null;
  let shown = false;
  const magnets = new Map<HTMLElement, { x: number; y: number; release?: boolean }>();
  const current = new Map<HTMLElement, { x: number; y: number }>();

  const onMove = (e: PointerEvent) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (!shown) {
      shown = true;
      ringPos.x = mouse.x;
      ringPos.y = mouse.y;
      ring.style.opacity = "1";
      dot.style.opacity = "1";
    }
    const el = (e.target as HTMLElement).closest
      ? ((e.target as HTMLElement).closest(CURSOR_TARGET_SELECTOR) as HTMLElement | null)
      : null;
    const isCanvas = (e.target as HTMLElement).tagName === "CANVAS";
    if (el !== target) {
      target = el;
      ring.style.borderColor = el ? "rgba(178,95,62,.9)" : "rgba(178,95,62,.55)";
      ring.style.background = el ? "rgba(178,95,62,.10)" : "rgba(255,255,255,.08)";
      dot.style.transform = el ? "scale(0)" : "scale(1)";
    }
    label.textContent = isCanvas && !el ? "Glisser" : "";
    const size = isCanvas && !el ? 76 : el && el.tagName !== "INPUT" ? 0 : el ? 30 : 44;
    if (size) {
      ring.style.width = ring.style.height = `${size}px`;
      ring.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
      // Exactly half the box, not an oversized constant: a huge starting
      // radius stays visually clamped to "fully round" for most of the
      // shrink toward a small hover target (e.g. 8px for a square-cornered
      // link), only visibly snapping to the real value right at the end —
      // reads as the radius lagging behind width/height even though every
      // property shares the same easing and duration.
      ring.style.borderRadius = `${size / 2}px`;
    }

    document.querySelectorAll<HTMLElement>(MAGNETIC_SELECTOR).forEach((b) => {
      if (b.closest("nav")) return;
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = mouse.x - cx;
      const dy = mouse.y - cy;
      const inside = Math.hypot(dx / (r.width / 2 + 50), dy / (r.height / 2 + 50)) < 1;
      if (inside && r.width < 360) magnets.set(b, { x: dx * 0.22, y: dy * 0.3 });
      else if (magnets.has(b)) magnets.set(b, { x: 0, y: 0, release: true });
    });
  };
  const onLeave = () => {
    shown = false;
    ring.style.opacity = "0";
    dot.style.opacity = "0";
  };
  const onDown = () => {
    ring.style.transform += " scale(.86)";
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  window.addEventListener("pointerdown", onDown);

  function loop() {
    let tx = mouse.x;
    let ty = mouse.y;
    if (target && target.tagName !== "INPUT") {
      const r = target.getBoundingClientRect();
      const pad = 8;
      const w = r.width + pad * 2;
      const h = r.height + pad * 2;
      tx = r.left + r.width / 2 + (mouse.x - (r.left + r.width / 2)) * 0.12;
      ty = r.top + r.height / 2 + (mouse.y - (r.top + r.height / 2)) * 0.12;
      ring.style.width = `${w}px`;
      ring.style.height = `${h}px`;
      ring.style.margin = `${-h / 2}px 0 0 ${-w / 2}px`;
      const targetRadius = getComputedStyle(target).borderRadius;
      ring.style.borderRadius = targetRadius === "50%" ? "50%" : `${Math.min(h / 2, parseFloat(targetRadius) + pad || h / 2)}px`;
    }
    ringPos.x += (tx - ringPos.x) * 0.18;
    ringPos.y += (ty - ringPos.y) * 0.18;
    ring.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0)`;
    dot.style.left = `${mouse.x}px`;
    dot.style.top = `${mouse.y}px`;

    magnets.forEach((m, b) => {
      const c = current.get(b) || { x: 0, y: 0 };
      c.x += (m.x - c.x) * 0.14;
      c.y += (m.y - c.y) * 0.14;
      current.set(b, c);
      b.style.transform = `translate3d(${c.x.toFixed(2)}px, ${c.y.toFixed(2)}px, 0)`;
      if (m.release && Math.abs(c.x) < 0.1 && Math.abs(c.y) < 0.1) {
        b.style.transform = "";
        magnets.delete(b);
        current.delete(b);
      }
    });
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// Lenis lisse le scroll sur toute la page (ancres de nav incluses). On le
// saute si l'utilisateur demande moins de mouvement — même raison que pour
// le curseur et le fond ambiant : un easing imposé peut gêner plus qu'aider.
function initSmoothScroll() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Lenis defaults both autoRaf and anchors to false — without autoRaf it
  // never actually ticks (wheel deltas get captured but never interpolated),
  // and without anchors the nav's #hash links fall through to a native
  // instant jump instead of being smooth-scrolled.
  new Lenis({ lerp: 0.1, smoothWheel: true, autoRaf: true, anchors: true });
}

// Même modèle que le configurateur, figé sur une combinaison fixe (test :
// remplace le blob CSS du hero par la vraie paire de lunettes).
//
// La monture tourne lentement au repos (auto-rotate) : vue de 3/4, sa largeur
// apparente dépasse sa largeur au repos car les branches (qui s'étendent en
// profondeur à peu près autant que la monture en largeur) basculent dans le
// champ de la caméra. À l'échelle agrandie demandée ici, ça dépassait le
// cadre à certains angles — recule la caméra (sans changer l'échelle de la
// géométrie) pour garder de la marge pendant la rotation.
async function initHeroGlasses() {
  const host = document.getElementById("heroGlassesHost");
  if (!host) return;

  const hero = new GlassesConfigurator(host, 5.6);
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) hero.start();
        else hero.stop();
      }
    },
    { threshold: 0.01 },
  );
  io.observe(host);

  await hero.load(2);
  hero.applyMaterials("terre", "poli", "bleu");
}

export function initExperience() {
  initSmoothScroll();
  initHeroGlasses();
  initConfigurator();
  initVision();
  initProgressiveLens();
  initCursor();
}
