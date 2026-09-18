declare module 'react-cytoscapejs' {
  import { Component } from 'react';
  import type { Core, ElementDefinition, CytoscapeOptions } from 'cytoscape';

  interface CytoscapeStylesheet {
    selector: string;
    style: Record<string, unknown>;
  }

  interface CytoscapeComponentProps {
    elements: ElementDefinition[];
    stylesheet?: CytoscapeStylesheet[];
    cy?: (cy: Core) => void;
    style?: React.CSSProperties;
    className?: string;
    id?: string;
    zoom?: number;
    pan?: { x: number; y: number };
    minZoom?: number;
    maxZoom?: number;
    zoomingEnabled?: boolean;
    userZoomingEnabled?: boolean;
    panningEnabled?: boolean;
    userPanningEnabled?: boolean;
    boxSelectionEnabled?: boolean;
    autoungrabify?: boolean;
    autounselectify?: boolean;
    layout?: CytoscapeOptions['layout'];
    [key: string]: unknown;
  }

  export default class CytoscapeComponent extends Component<CytoscapeComponentProps> {}
}
