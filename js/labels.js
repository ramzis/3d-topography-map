import * as THREE from 'three';

export function makeLabel(text, color, heightUnits) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    depthTest: false,
    transparent: true,
  }));
  sprite.renderOrder = 10;
  sprite.userData.labelParams = { text, heightUnits };
  recolorLabel(sprite, color);
  return sprite;
}

export function recolorLabel(sprite, color) {
  const { text, heightUnits } = sprite.userData.labelParams;
  const font = '600 96px system-ui, -apple-system, "Segoe UI", sans-serif';

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const pad = 28;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = 96 + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // soft shadow for readability against any terrain color
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + 4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const mat = sprite.material;
  if (mat.map) mat.map.dispose();
  mat.map = texture;
  mat.needsUpdate = true;

  sprite.scale.set(heightUnits * (w / h), heightUnits, 1);
}
