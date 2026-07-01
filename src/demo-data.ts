import type { PortfolioSnapshot } from "./types.js";

/**
 * Fictional portfolio used by `--demo` so the dashboard can be previewed and
 * shared before wiring up real Rent Manager credentials.
 */
export function demoSnapshot(): PortfolioSnapshot {
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  const agoDays = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  return {
    generatedAt: now.toISOString(),
    properties: [
      {
        PropertyID: 1,
        PropertyName: "Sunflower Estates",
        TotalUnits: 48,
        OccupiedUnits: 45,
        VacantUnits: 3,
        OccupancyRate: 93.8,
        ScheduledMonthlyRent: 58_950,
        DelinquentTenants: 4,
        DelinquentBalance: 6_240,
      },
      {
        PropertyID: 2,
        PropertyName: "Oak Park Apartments",
        TotalUnits: 36,
        OccupiedUnits: 34,
        VacantUnits: 2,
        OccupancyRate: 94.4,
        ScheduledMonthlyRent: 47_600,
        DelinquentTenants: 2,
        DelinquentBalance: 2_890,
      },
      {
        PropertyID: 3,
        PropertyName: "Maple Ridge",
        TotalUnits: 24,
        OccupiedUnits: 21,
        VacantUnits: 3,
        OccupancyRate: 87.5,
        ScheduledMonthlyRent: 31_500,
        DelinquentTenants: 3,
        DelinquentBalance: 7_815,
      },
      {
        PropertyID: 4,
        PropertyName: "Cedar Court Townhomes",
        TotalUnits: 16,
        OccupiedUnits: 16,
        VacantUnits: 0,
        OccupancyRate: 100,
        ScheduledMonthlyRent: 27_200,
        DelinquentTenants: 1,
        DelinquentBalance: 1_700,
      },
      {
        PropertyID: 5,
        PropertyName: "Birchwood Commons",
        TotalUnits: 60,
        OccupiedUnits: 52,
        VacantUnits: 8,
        OccupancyRate: 86.7,
        ScheduledMonthlyRent: 66_560,
        DelinquentTenants: 5,
        DelinquentBalance: 9_430,
      },
    ],
    delinquencies: [
      { TenantID: 101, TenantName: "Marcus Webb", UnitName: "12B", PropertyName: "Maple Ridge", Balance: 4_350, DaysPastDue: 95, LastPaymentDate: agoDays(98), LastPaymentAmount: 750 },
      { TenantID: 102, TenantName: "Dana Whitfield", UnitName: "204", PropertyName: "Birchwood Commons", Balance: 3_120, DaysPastDue: 62, LastPaymentDate: agoDays(64), LastPaymentAmount: 1_280 },
      { TenantID: 103, TenantName: "Luis Herrera", UnitName: "7", PropertyName: "Sunflower Estates", Balance: 2_460, DaysPastDue: 48, LastPaymentDate: agoDays(51), LastPaymentAmount: 615 },
      { TenantID: 104, TenantName: "Priya Natarajan", UnitName: "318", PropertyName: "Birchwood Commons", Balance: 2_240, DaysPastDue: 35, LastPaymentDate: agoDays(37), LastPaymentAmount: 1_120 },
      { TenantID: 105, TenantName: "Rob Callahan", UnitName: "22", PropertyName: "Sunflower Estates", Balance: 1_890, DaysPastDue: 28, LastPaymentDate: agoDays(31), LastPaymentAmount: 945 },
      { TenantID: 106, TenantName: "Aisha Douglas", UnitName: "5A", PropertyName: "Maple Ridge", Balance: 1_775, DaysPastDue: 55, LastPaymentDate: agoDays(57), LastPaymentAmount: 890 },
      { TenantID: 107, TenantName: "Tom & Erin Sadowski", UnitName: "T-9", PropertyName: "Cedar Court Townhomes", Balance: 1_700, DaysPastDue: 12, LastPaymentDate: agoDays(42), LastPaymentAmount: 1_700 },
      { TenantID: 108, TenantName: "Gwen Okafor", UnitName: "141", PropertyName: "Birchwood Commons", Balance: 1_610, DaysPastDue: 22, LastPaymentDate: agoDays(24), LastPaymentAmount: 805 },
      { TenantID: 109, TenantName: "Hank Meyers", UnitName: "16", PropertyName: "Sunflower Estates", Balance: 1_120, DaysPastDue: 18, LastPaymentDate: agoDays(20), LastPaymentAmount: 560 },
      { TenantID: 110, TenantName: "Celia Fontaine", UnitName: "9C", PropertyName: "Maple Ridge", Balance: 1_690, DaysPastDue: 40, LastPaymentDate: agoDays(44), LastPaymentAmount: 845 },
      { TenantID: 111, TenantName: "Devon Price", UnitName: "230", PropertyName: "Birchwood Commons", Balance: 1_460, DaysPastDue: 8, LastPaymentDate: agoDays(38), LastPaymentAmount: 1_460 },
      { TenantID: 112, TenantName: "Jae-won Park", UnitName: "112", PropertyName: "Oak Park Apartments", Balance: 1_540, DaysPastDue: 25, LastPaymentDate: agoDays(28), LastPaymentAmount: 770 },
      { TenantID: 113, TenantName: "Bianca Ruiz", UnitName: "208", PropertyName: "Oak Park Apartments", Balance: 1_350, DaysPastDue: 6, LastPaymentDate: agoDays(36), LastPaymentAmount: 1_350 },
      { TenantID: 114, TenantName: "Omar Haddad", UnitName: "31", PropertyName: "Sunflower Estates", Balance: 770, DaysPastDue: 5, LastPaymentDate: agoDays(35), LastPaymentAmount: 770 },
      { TenantID: 115, TenantName: "Krista Lindqvist", UnitName: "402", PropertyName: "Birchwood Commons", Balance: 1_000, DaysPastDue: 15, LastPaymentDate: agoDays(17), LastPaymentAmount: 500 },
    ],
    expiringLeases: [
      { TenantID: 201, TenantName: "Felicity Nguyen", UnitName: "104", PropertyName: "Oak Park Apartments", LeaseEnd: inDays(11), DaysUntilExpiration: 11, MonthlyRent: 1_340 },
      { TenantID: 202, TenantName: "Grant Osei", UnitName: "27", PropertyName: "Sunflower Estates", LeaseEnd: inDays(19), DaysUntilExpiration: 19, MonthlyRent: 1_225 },
      { TenantID: 203, TenantName: "Melody Tran", UnitName: "T-3", PropertyName: "Cedar Court Townhomes", LeaseEnd: inDays(26), DaysUntilExpiration: 26, MonthlyRent: 1_710 },
      { TenantID: 204, TenantName: "Sasha Baranov", UnitName: "315", PropertyName: "Birchwood Commons", LeaseEnd: inDays(38), DaysUntilExpiration: 38, MonthlyRent: 1_280 },
      { TenantID: 205, TenantName: "Wyatt & June Pearce", UnitName: "8A", PropertyName: "Maple Ridge", LeaseEnd: inDays(47), DaysUntilExpiration: 47, MonthlyRent: 1_495 },
      { TenantID: 206, TenantName: "Imani Clarke", UnitName: "219", PropertyName: "Oak Park Apartments", LeaseEnd: inDays(59), DaysUntilExpiration: 59, MonthlyRent: 1_310 },
      { TenantID: 207, TenantName: "Nolan Brandt", UnitName: "44", PropertyName: "Sunflower Estates", LeaseEnd: inDays(71), DaysUntilExpiration: 71, MonthlyRent: 1_250 },
      { TenantID: 208, TenantName: "Yara Soliman", UnitName: "127", PropertyName: "Birchwood Commons", LeaseEnd: inDays(83), DaysUntilExpiration: 83, MonthlyRent: 1_265 },
    ],
    vacantUnits: [
      { UnitID: 301, UnitName: "306", PropertyName: "Birchwood Commons", MarketRent: 1_275, LastMoveOutDate: agoDays(64), DaysVacant: 64 },
      { UnitID: 302, UnitName: "3C", PropertyName: "Maple Ridge", MarketRent: 1_450, LastMoveOutDate: agoDays(51), DaysVacant: 51 },
      { UnitID: 303, UnitName: "118", PropertyName: "Birchwood Commons", MarketRent: 1_240, LastMoveOutDate: agoDays(42), DaysVacant: 42 },
      { UnitID: 304, UnitName: "9", PropertyName: "Sunflower Estates", MarketRent: 1_195, LastMoveOutDate: agoDays(33), DaysVacant: 33 },
      { UnitID: 305, UnitName: "223", PropertyName: "Birchwood Commons", MarketRent: 1_260, LastMoveOutDate: agoDays(27), DaysVacant: 27 },
      { UnitID: 306, UnitName: "14D", PropertyName: "Maple Ridge", MarketRent: 1_380, LastMoveOutDate: agoDays(21), DaysVacant: 21 },
      { UnitID: 307, UnitName: "410", PropertyName: "Birchwood Commons", MarketRent: 1_295, LastMoveOutDate: agoDays(14), DaysVacant: 14 },
      { UnitID: 308, UnitName: "35", PropertyName: "Sunflower Estates", MarketRent: 1_210, LastMoveOutDate: agoDays(9), DaysVacant: 9 },
      { UnitID: 309, UnitName: "302", PropertyName: "Oak Park Apartments", MarketRent: 1_330, LastMoveOutDate: agoDays(6), DaysVacant: 6 },
      { UnitID: 310, UnitName: "127B", PropertyName: "Birchwood Commons", MarketRent: 1_255, LastMoveOutDate: agoDays(3), DaysVacant: 3 },
      { UnitID: 311, UnitName: "8", PropertyName: "Sunflower Estates", MarketRent: 1_205, LastMoveOutDate: null, DaysVacant: null },
      { UnitID: 312, UnitName: "241", PropertyName: "Birchwood Commons", MarketRent: 1_250, LastMoveOutDate: null, DaysVacant: null },
      { UnitID: 313, UnitName: "312", PropertyName: "Birchwood Commons", MarketRent: 1_270, LastMoveOutDate: null, DaysVacant: null },
      { UnitID: 314, UnitName: "11A", PropertyName: "Maple Ridge", MarketRent: 1_420, LastMoveOutDate: null, DaysVacant: null },
      { UnitID: 315, UnitName: "104", PropertyName: "Oak Park Apartments", MarketRent: 1_315, LastMoveOutDate: null, DaysVacant: null },
      { UnitID: 316, UnitName: "205", PropertyName: "Birchwood Commons", MarketRent: 1_245, LastMoveOutDate: null, DaysVacant: null },
    ],
  };
}
