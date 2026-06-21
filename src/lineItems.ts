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
  canReplace: boolean;
}

export const ITEM_TYPES: Record<ItemType, ItemTypeDef> = {
  catalog: {
    segment: "catalogs",
    anchorField: "Catalog",
    createHint: "fields.Catalog (int, catalog item ID) + fields.Total: { Qty }",
    canUpdate: true,
    canDelete: true,
    canReplace: true,
  },
  labor: {
    segment: "labor",
    anchorField: "LaborType",
    createHint: "fields.LaborType (int) + fields.Total",
    canUpdate: true,
    canDelete: true,
    canReplace: true,
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
    canReplace: true,
  },
  prebuild: {
    segment: "prebuilds",
    anchorField: "Prebuild",
    createHint: "fields.Prebuild (int) + fields.Total: { Qty }",
    canUpdate: true,
    canDelete: true,
    canReplace: true,
  },
  serviceFee: {
    segment: "serviceFees",
    anchorField: "ServiceFee",
    createHint: "fields.ServiceFee (int) + fields.Total",
    canUpdate: true,
    canDelete: true,
    canReplace: true,
  },
  stock: {
    segment: "stock",
    anchorField: "AssignedBreakdown",
    createHint: "fields.AssignedBreakdown (array) + optional fields.Catalog (int)",
    canUpdate: true,
    canDelete: false, // API has no DELETE for stock
    canReplace: false,
  },
  asset: {
    segment: "assets",
    anchorField: "Asset",
    createHint: "fields.Asset (int, asset ID to attach)",
    canUpdate: false, // API has no PATCH for assets
    canDelete: true,
    canReplace: true,
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
