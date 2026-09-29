import type { Snapshot } from './types';

/** Sanitized flat tree. Parents precede children; native nodes stay in-frame. */
export interface PageNode {
  id: string;
  parent?: string;
  role?: string;
  text?: string;
  inView: boolean;
  elementId?: string;
  frameIndex?: number;
}
export interface PageMetadata { framePath: number[]; tree: PageNode[] }
export interface PageObservation { snapshot: Snapshot; metadata: PageMetadata }
