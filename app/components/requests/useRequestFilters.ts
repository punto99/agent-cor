"use client";

import { useState } from "react";
import type { ExternalRequest, FilterOption } from "./types";

const brandIdentity = (r: ExternalRequest) => JSON.stringify([r.clientKey, r.brandKey]);
const subBrandIdentity = (r: ExternalRequest) => JSON.stringify([r.clientKey, r.brandKey, r.subBrandKey]);
function options(items: ExternalRequest[], key: (r: ExternalRequest) => string, label: (r: ExternalRequest) => string | undefined): FilterOption[] {
  const result = new Map<string, string>();
  items.forEach((r) => { const name = label(r); if (name) result.set(key(r), name); });
  return Array.from(result, ([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
}
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();

export function useRequestFilters(requests: ExternalRequest[]) {
  const [search, setSearch] = useState("");
  const [client, setClient] = useState("");
  const [brand, setBrand] = useState("");
  const [subBrand, setSubBrand] = useState("");
  const clients = options(requests, (r) => r.clientKey, (r) => r.clientName);
  const selectedClient = clients.some((o) => o.key === client) ? client : "";
  const clientRequests = requests.filter((r) => !selectedClient || r.clientKey === selectedClient);
  const brands = options(clientRequests, brandIdentity, (r) => r.brandName);
  const selectedBrand = brands.some((o) => o.key === brand) ? brand : "";
  const brandRequests = clientRequests.filter((r) => !selectedBrand || brandIdentity(r) === selectedBrand);
  const subBrands = options(brandRequests, subBrandIdentity, (r) => r.subBrandName);
  const selectedSubBrand = subBrands.some((o) => o.key === subBrand) ? subBrand : "";
  const filtered = brandRequests.filter((r) =>
    (!selectedSubBrand || subBrandIdentity(r) === selectedSubBrand) &&
    normalize([r.title, r.description, r.clientName, r.brandName, r.subBrandName].join(" ")).includes(normalize(search.trim())),
  );
  return {
    filtered, clients, brands, subBrands, search, setSearch,
    client: selectedClient, brand: selectedBrand, subBrand: selectedSubBrand,
    setClient: (value: string) => { setClient(value); setBrand(""); setSubBrand(""); },
    setBrand: (value: string) => { setBrand(value); setSubBrand(""); },
    setSubBrand,
  };
}

