
export type LngLat = { lng: number, lat: number };
export type LngLatLike = [number, number] | LngLat;
export type Padding = { top: number, right: number, bottom: number, left: number };
export type Camera = { center: LngLatLike, zoom: number, bearing: number };
export type Feature = { id?: string | number, properties: Record<string, unknown>, layer: { id: string },
  geometry: { type: string, coordinates: unknown } };
export type MapEvent = { point: { x: number, y: number }, lngLat: LngLat, features?: Feature[], preventDefault(): void };

export interface Control {
  onAdd(map: LibreMap): HTMLElement;
  onRemove(): void;
}

export type Tile = { state: 'loading' | 'loaded' | 'reloading' | 'unloaded' | 'errored' | 'expired', aborted?: boolean };

export interface GeoJSONSource {
  loadTile(tile: Tile): Promise<void>;
  setData(data: object): void;
  getClusterExpansionZoom(clusterId: number): Promise<number>;
  setClusterOptions(options: { cluster?: boolean, clusterRadius?: number, clusterMaxZoom?: number }): GeoJSONSource;
}

export interface LibreMap {
  addControl(control: Control, position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): LibreMap;
  on(type: string, listener: (event: MapEvent) => void): LibreMap;
  on(type: string, layer: string, listener: (event: MapEvent) => void): LibreMap;
  off(type: string, listener: (event: MapEvent) => void): LibreMap;
  once(type: string, listener: (event: MapEvent) => void): LibreMap;
  getSource(id: string): GeoJSONSource | undefined;
  addSource(id: string, source: { type: 'geojson', data: object }): LibreMap;
  addLayer(layer: { id: string, type: string, source: string, layout?: Record<string, unknown>, paint?: Record<string, unknown> }, before?: string): LibreMap;
  hasImage(id: string): boolean;
  addImage(id: string, image: { width: number, height: number, data: Uint8Array | Uint8ClampedArray }, options?: { pixelRatio?: number,
    stretchX?: [number, number][], stretchY?: [number, number][], content?: [number, number, number, number] }): void;
  removeImage(id: string): void;
  getCanvas(): HTMLCanvasElement;
  getCanvasContainer(): HTMLElement;
  getContainer(): HTMLElement;
  project(at: LngLatLike): { x: number, y: number };
  unproject(at: [number, number]): LngLat;
  getCenter(): LngLat;
  getZoom(): number;
  getBearing(): number;
  jumpTo(camera: Partial<Camera>): LibreMap;
  easeTo(camera: Partial<Camera> & { duration?: number, easing?: (t: number) => number, padding?: Partial<Padding> }): LibreMap;
  fitBounds(bounds: [[number, number], [number, number]], options: { padding: Padding, maxZoom: number, duration: number,
    linear: boolean, easing?: (t: number) => number, essential?: boolean }): LibreMap;
  resetNorth(options?: { duration?: number }): LibreMap;
  setFeatureState(feature: { source: string, id: string | number }, state: Record<string, unknown>): void;
  getLayer(id: string): object | undefined;
  setPaintProperty(layer: string, name: string, value: unknown): LibreMap;
  setLayoutProperty(layer: string, name: string, value: unknown): LibreMap;
  getLayoutProperty(layer: string, name: string): unknown;
  setFilter(layer: string, filter: unknown): LibreMap;
  getStyle(): { layers: { id: string, type: string, source?: string, filter?: unknown }[] };
  triggerRepaint(): void;
  queryRenderedFeatures(geometry: [[number, number], [number, number]] | { layers: string[] }, options?: { layers: string[] }): Feature[];
  setStyle(style: object, options?: { diff: boolean }): LibreMap;
  isStyleLoaded(): boolean;
  remove(): void;
}

export type MapOptions = {
  container: HTMLElement,
  style: object,
  attributionControl: false,
  center?: LngLatLike,
  zoom?: number,
  bearing?: number,
  maxPitch?: number,
  pitchWithRotate?: boolean,
  touchPitch?: boolean,
  cooperativeGestures?: boolean,
  fadeDuration?: number,
  dragPan?: boolean,
  dragRotate?: boolean,
  scrollZoom?: boolean,
  boxZoom?: boolean,
  doubleClickZoom?: boolean,
  keyboard?: boolean,
  touchZoomRotate?: boolean,
};

export interface MapLibre {
  Map: new (options: MapOptions) => LibreMap;
  AttributionControl: new (options: { compact: boolean }) => Control;
  ScaleControl: new (options: { maxWidth: number, unit: 'metric' }) => Control;
  setWorkerUrl(url: string): void;
}
