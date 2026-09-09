/**
 * ARPropertyProvider — interface only.
 *
 * The iOS side already has an `ARManager` scaffold using ARKit +
 * ARGeoTrackingConfiguration; this server-side interface exposes only
 * the metadata a client needs (anchor GPS + heading + optional overlay
 * asset id) so a future service can serve persisted anchors. No real
 * cloud-anchor service is wired in.
 */

export interface ARAnchorRecord {
  anchorId: string;
  propertyId: string;
  latitude: number;
  longitude: number;
  altitudeMeters?: number;
  headingDegrees?: number;
  overlayAssetId?: string;
}

export interface ARPropertyProvider {
  readonly name: string;
  listAnchors(propertyId: string): Promise<ARAnchorRecord[]>;
}

export class UnavailableARPropertyProvider implements ARPropertyProvider {
  readonly name = 'unavailable';
  async listAnchors(_propertyId: string): Promise<ARAnchorRecord[]> {
    return [];
  }
}

let provider: ARPropertyProvider = new UnavailableARPropertyProvider();
export function getARPropertyProvider(): ARPropertyProvider { return provider; }
export function setARPropertyProvider(next: ARPropertyProvider): void { provider = next; }
