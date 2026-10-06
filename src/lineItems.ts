export type ItemType =
  | "catalog"
  | "labor"
  | "oneOff"
  | "prebuild"
  | "serviceFee"
  | "stock"
  | "asset";

export interface ItemTypeDef {
  segment: string;
  anchorField: string;
  createHint: string;
  canUpdate: boolean;
  canDelete: boolean;
}

export const ITEM_TYPES: Record<ItemType, ItemTypeDef> = {
  catalog: {
    segment: "catalogs",
    anchorField: "Catalog",
    createHint: "fields.Catalog (int, catalog item ID) + fields.Total: { Qty }",
    canUpdate: true,
    canDelete: true,
  },
  labor: {
    segment: "labor",
    anchorField: "LaborType",
    createHint: "fields.LaborType (int) + fields.Total",
    canUpdate: true,
    canDelete: true,
  },
  oneOff: {
    segment: "oneOffs",
    anchorField: "Type",
    createHint:
      "fields.Type ('Material'|'Labor') + fields.Description + fields.Total ({ Qty }); " +
      "set the sell with fields.SellPriceExDiscount (number) for an exact price, " +
      "or fields.EstimatedCost + fields.Markup. Do not POST SellPrice as { ExTax } (read-only shape).",
    canUpdate: true,
    canDelete: true,
  },
  prebuild: {
    segment: "prebuilds",
    anchorField: "Prebuild",
    createHint: "fields.Prebuild (int) + fields.Total: { Qty }",
    canUpdate: true,
    canDelete: true,
  },
  serviceFee: {
    segment: "serviceFees",
    anchorField: "ServiceFee",
    createHint: "fields.ServiceFee (int) + fields.Total",
    canUpdate: true,
    canDelete: true,
  },
  stock: {
    segment: "stock",
    anchorField: "AssignedBreakdown",
    createHint: "fields.AssignedBreakdown (array) + optional fields.Catalog (int)",
    canUpdate: true,
    canDelete: false, // API has no DELETE for stock
  },
  asset: {
    segment: "assets",
    anchorField: "Asset",
    createHint: "fields.Asset (int, asset ID to attach)",
    canUpdate: false, // API has no PATCH for assets
    canDelete: true,
  },
};

export const ITEM_TYPE_KEYS = Object.keys(ITEM_TYPES) as [ItemType, ...ItemType[]];

export function itemCollectionPath(
  entity: "job" | "quote",
  id: number,
  sectionID: number,
  costCenterID: number,
  type: ItemType,
): string {
  const base = entity === "quote" ? "quotes" : "jobs";
  return `${base}/${id}/sections/${sectionID}/costCenters/${costCenterID}/${ITEM_TYPES[type].segment}/`;
}

export type LineItemOp =
  | { op: "add"; itemType: ItemType; fields: Record<string, unknown> }
  | { op: "update"; itemType: ItemType; itemID: number; fields: Record<string, unknown> }
  | { op: "delete"; itemType: ItemType; itemID: number };

export type LineItemStep =
  | { op: "add"; itemType: ItemType; indexes: number[]; bodies: Record<string, unknown>[] }
  | { op: "update"; itemType: ItemType; indexes: [number]; itemID: number; fields: Record<string, unknown> }
  | { op: "delete"; itemType: ItemType; indexes: [number]; itemID: number };

export function validateLineItemOps(ops: LineItemOp[]): string[] {
  const errors: string[] = [];
  ops.forEach((o, i) => {
    if (o.op === "update" && !ITEM_TYPES[o.itemType].canUpdate) {
      errors.push(`ops[${i}]: ${o.itemType} lines have no Simpro update endpoint; delete the line and add it again.`);
    }
    if (o.op === "delete" && !ITEM_TYPES[o.itemType].canDelete) {
      errors.push(`ops[${i}]: ${o.itemType} lines have no Simpro delete endpoint.`);
    }
  });
  return errors;
}

// Consecutive adds of one type share a request; anything else keeps its place so ops run in the order given.
export function planLineItemOps(ops: LineItemOp[]): LineItemStep[] {
  const steps: LineItemStep[] = [];
  ops.forEach((o, i) => {
    const prev = steps[steps.length - 1];
    if (o.op === "add") {
      if (prev?.op === "add" && prev.itemType === o.itemType) {
        prev.indexes.push(i);
        prev.bodies.push(o.fields);
      } else {
        steps.push({ op: "add", itemType: o.itemType, indexes: [i], bodies: [o.fields] });
      }
    } else if (o.op === "update") {
      steps.push({ op: "update", itemType: o.itemType, indexes: [i], itemID: o.itemID, fields: o.fields });
    } else {
      steps.push({ op: "delete", itemType: o.itemType, indexes: [i], itemID: o.itemID });
    }
  });
  return steps;
}
