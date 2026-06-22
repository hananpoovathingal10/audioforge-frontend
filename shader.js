/* =====================================================
   NEBULA — Vertex + Fragment Volume Shader (GLSL)
   Exported as string constants for Three.js ShaderMaterial
   ===================================================== */

const NEBULA_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const NEBULA_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform float uBass;      // 0.0 – 1.0  → cloud density / expansion
  uniform float uTreble;    // 0.0 – 1.0  → shimmer / flicker intensity
  uniform float uMid;       // 0.0 – 1.0  → color shift
  uniform float uTheme;     // 0.0 = Deep Space, 1.0 = Supernova, 2.0 = Emerald
  uniform vec2  uResolution;

  // ── Utility hash / noise ────────────────────────────

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  // Smooth 3D value noise
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep

    float n = i.x + i.y * 57.0 + i.z * 113.0;

    return mix(
      mix(mix(hash(n + 0.0),  hash(n + 1.0),  f.x),
          mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y),
      mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
          mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y),
      f.z
    );
  }

  // Fractal Brownian Motion — layered noise
  float fbm(vec3 p, int octaves) {
    float val   = 0.0;
    float amp   = 0.5;
    float freq  = 1.0;
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      val   += noise3(p * freq) * amp;
      total += amp;
      amp  *= 0.52;
      freq *= 2.01;
    }
    return val / total;
  }

  // ── Domain-warped fbm for richer cloud forms ─────────

  float warpedFbm(vec3 p, float warp) {
    vec3 q = vec3(
      fbm(p + vec3(0.0,  0.0,  0.0), 5),
      fbm(p + vec3(5.2,  1.3,  2.7), 5),
      fbm(p + vec3(9.1,  3.4,  1.1), 5)
    );
    vec3 r = vec3(
      fbm(p + warp * q + vec3(1.7, 9.2, 3.3), 6),
      fbm(p + warp * q + vec3(8.3, 2.8, 6.1), 6),
      fbm(p + warp * q + vec3(4.1, 7.4, 0.5), 6)
    );
    return fbm(p + warp * r, 7);
  }

  // ── Ray-march density sampler ────────────────────────

  float sampleDensity(vec3 pos) {
    float t = uTime * 0.08;

    // Bass expands the cloud radius / density
    float bassExpand = 1.0 + uBass * 2.2;

    // Slowly drift the cloud
    vec3 p = pos * 0.55 * bassExpand;
    p += vec3(t * 0.18, t * 0.09, t * 0.12);

    float warpAmt = 2.8 + uBass * 1.8;
    float density = warpedFbm(p, warpAmt);

    // Carve a hollow sphere so there's an interior void
    float r = length(pos);
    float shell = smoothstep(0.35, 0.55, r) * smoothstep(1.6, 1.0, r);

    // Treble adds high-freq shimmer flicker
    float shimmerFreq = 18.0 + uTreble * 22.0;
    float shimmer = noise3(pos * shimmerFreq + vec3(t * 3.0)) * uTreble * 0.35;

    return clamp((density * shell + shimmer) * 1.35, 0.0, 1.0);
  }

  // ── Colour palette ───────────────────────────────────

  vec3 nebulaPalette(float density, float height, float mid) {
    vec3 col0, col1, col2, col3, midTint;

    if (uTheme > 1.5) {
      // Emerald / Mint
      col0 = vec3(0.01, 0.12, 0.08); // dark forest green
      col1 = vec3(0.05, 0.65, 0.40); // vibrant emerald
      col2 = vec3(0.10, 0.85, 0.70); // mint/teal
      col3 = vec3(0.70, 0.98, 0.80); // light green-cyan
      midTint = vec3(0.95, 0.85, 0.20); // warm gold
    } else if (uTheme > 0.5) {
      // Supernova / Flame
      col0 = vec3(0.15, 0.02, 0.05); // dark violet-red
      col1 = vec3(0.85, 0.15, 0.35); // hot pink/magenta
      col2 = vec3(0.95, 0.45, 0.10); // neon orange
      col3 = vec3(0.98, 0.85, 0.30); // warm yellow
      midTint = vec3(0.50, 0.10, 0.80); // violet-purple
    } else {
      // Deep Space (Default)
      col0 = vec3(0.08, 0.02, 0.18); // dark violet
      col1 = vec3(0.40, 0.10, 0.80); // vivid purple
      col2 = vec3(0.10, 0.55, 0.95); // electric blue
      col3 = vec3(0.05, 0.88, 0.78); // cyan-teal
      midTint = vec3(0.90, 0.20, 0.60); // warm pink
    }

    float t = clamp(density * 1.5, 0.0, 1.0);
    vec3 cool = mix(mix(col0, col1, t), mix(col2, col3, t), t);
    return mix(cool, mix(cool, midTint, 0.6), mid * 0.45);
  }

  // ── Main ─────────────────────────────────────────────

  void main() {
    // UV → NDC (-1 to +1)
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uResolution.x / uResolution.y;

    // Ray origin & direction
    vec3 ro = vec3(0.0, 0.0, 3.2);
    vec3 rd = normalize(vec3(uv, -1.8));

    // ── Ray March ──────────────────────────────────────
    vec3  accumColor  = vec3(0.0);
    float accumAlpha  = 0.0;
    float stepLen     = 0.038;
    int   maxSteps    = 72;

    float t = 0.3;
    for (int i = 0; i < 72; i++) {
      if (accumAlpha >= 0.98) break;

      vec3 pos  = ro + rd * t;
      float r   = length(pos);

      // Bounding sphere test
      if (r < 0.3 || r > 1.85) { t += stepLen; continue; }

      float density = sampleDensity(pos);

      if (density > 0.015) {
        vec3 col = nebulaPalette(density, pos.y, uMid);

        // Emission + self-shadowing approximation
        float emission = density * 1.8;
        float alpha    = 1.0 - exp(-density * stepLen * 14.0);

        accumColor += (1.0 - accumAlpha) * col * emission;
        accumAlpha += (1.0 - accumAlpha) * alpha;
      }

      t += stepLen;
    }

    // ── Background starfield ──────────────────────────
    vec3 bg = vec3(0.005, 0.003, 0.012);

    // scatter tiny stars
    float star = 0.0;
    for (int s = 0; s < 3; s++) {
      float sf = float(s) * 137.508 + 1.0;
      vec2 stUV = uv * sf;
      vec2 stCell = floor(stUV);
      vec2 stFrac = fract(stUV);
      float sh = hash(stCell.x * 7.3 + stCell.y * 91.7 + sf * 43.1);
      if (sh > 0.985) {
        float brightness = smoothstep(0.04, 0.0, length(stFrac - 0.5));
        // Twinkle driven by treble
        float twinkle = 0.7 + 0.3 * sin(uTime * (3.0 + sh * 5.0));
        star += brightness * twinkle * (0.4 + uTreble * 0.6);
      }
    }
    bg += vec3(0.75, 0.85, 1.0) * star;

    // ── Compose ──────────────────────────────────────
    vec3 finalColor = mix(bg, accumColor, accumAlpha);

    // Subtle vignette
    float vignette = 1.0 - 0.45 * dot(uv * 0.65, uv * 0.65);
    finalColor *= vignette;

    // Subtle bloom (additive glow on bright areas)
    float luminance = dot(finalColor, vec3(0.2126, 0.7152, 0.0722));
    finalColor += finalColor * smoothstep(0.6, 1.0, luminance) * 0.5;

    // Gamma correction (linear → sRGB)
    finalColor = pow(clamp(finalColor, 0.0, 1.0), vec3(1.0 / 2.2));

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;
