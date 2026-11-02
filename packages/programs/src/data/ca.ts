import type { StateCatalog } from "../types.js";

export const CA: StateCatalog = {
  "state": "CA",
  "programs": {
    "snap": {
      "state": "CA",
      "program": "snap",
      "name": {
        "value": "CalFresh",
        "sourceUrl": "https://www.cdss.ca.gov/inforesources/calfresh",
        "checkedAt": "2026-10-30",
        "quote": "CalFresh, known federally as the Supplemental Nutrition Assistance Program or SNAP, provides monthly food benefits to individuals and families with low-income"
      },
      "agency": {
        "value": "California Department of Social Services (CDSS) supervises CalFresh; county social services offices run it",
        "sourceUrl": "https://www.cdss.ca.gov/inforesources/calfresh",
        "checkedAt": "2026-10-30",
        "quote": "CalFresh is federally mandated and in California, is state-supervised and county-operated."
      },
      "covers": {
        "value": "Monthly food benefits on an EBT card that can be used to buy food at grocery stores and farmers markets that accept EBT.",
        "sourceUrl": "https://www.cdss.ca.gov/inforesources/calfresh",
        "checkedAt": "2026-10-30",
        "quote": "The program issues monthly benefits on an Electronic Benefit Transfer (EBT) card. Food may be purchased at any grocery store or farmers market that accepts EBT cards."
      },
      "incomeLimit": {
        "value": {
          "year": "FFY 2027 (October 1, 2026 through September 30, 2027)",
          "basis": "CDSS ACIN I-40-26, Attachment I, publishes three gross monthly income eligibility standards: 200% of poverty for Modified Categorical Eligibility (MCE)/Broad-Based Categorical Eligibility (BBCE), 130% of poverty for Semi-Annual Reporting, and 165% of poverty for households where an elderly or disabled person is a separate household.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "households with Modified Categorical Eligibility (MCE)/Broad-Based Categorical Eligibility (BBCE) status (200% of poverty)",
              "bySize": [
                2660,
                3608,
                4554,
                5500,
                6448,
                7394,
                8340,
                9288
              ],
              "eachAdditional": 948
            },
            {
              "appliesTo": "households without MCE/BBCE status (130% of poverty; the notice labels it the Semi-Annual Reporting gross standard, and the same figures are the income reporting threshold)",
              "bySize": [
                1729,
                2345,
                2960,
                3575,
                4191,
                4806,
                5421,
                6037
              ],
              "eachAdditional": 616
            }
          ]
        },
        "sourceUrl": "https://www.cdss.ca.gov/Portals/9/Additional-Resources/Letters-and-Notices/ACINs/2026/I-40_26.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Gross Monthly Income Eligibility Standards for Modified Categorical Eligibility (MCE)/Broad-Based Categorical Eligibility (BBCE)"
      },
      "netIncomeLimit": {
        "value": {
          "year": "FFY 2027 (October 1, 2026 through September 30, 2027)",
          "basis": "CDSS ACIN I-40-26, Attachment I, Net Monthly Income Eligibility Standards at 100% of poverty. The notice publishes one net table and does not say which households it applies to.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "all households (one net table, no group named)",
              "bySize": [
                1330,
                1804,
                2277,
                2750,
                3224,
                3697,
                4170,
                4644
              ],
              "eachAdditional": 474
            }
          ]
        },
        "sourceUrl": "https://www.cdss.ca.gov/Portals/9/Additional-Resources/Letters-and-Notices/ACINs/2026/I-40_26.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Net Monthly Income Eligibility Standards (100% of Poverty Level)"
      },
      "renewal": {
        "value": "Most households recertify every year and file a semi-annual report (SAR 7) in between; households with older adults recertify every two years, and households of older adults or people with disabilities with no earned income can get certification periods of up to 36 months.",
        "sourceUrl": "https://www.cdss.ca.gov/Portals/9/CCDD/FactSheets/CDSS-CalFresh-Eligibility-Fact-Sheet.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Most CalFresh households must recertify their eligibility annually"
      },
      "apply": {
        "value": "Apply online at BenefitsCal.com, call 1-877-847-3663 to be connected to your county, or visit your local county social services office.",
        "sourceUrl": "https://www.cdss.ca.gov/benefits-services/food-nutrition-services/calfresh/frequently-asked-questions",
        "checkedAt": "2026-10-30",
        "quote": "You can also contact your local county social services office. You can get connected by calling 1-877-847-3663 or by visiting a local office."
      },
      "phone": {
        "value": "1-877-847-3663",
        "sourceUrl": "https://www.cdss.ca.gov/inforesources/calfresh",
        "checkedAt": "2026-10-30",
        "quote": "CalFresh Information Line 1-877-847-3663"
      },
      "website": {
        "value": "https://benefitscal.com",
        "sourceUrl": "https://www.cdss.ca.gov/benefits-services/food-nutrition-services/calfresh/frequently-asked-questions",
        "checkedAt": "2026-10-30",
        "quote": "You can apply online at BenefitsCal.com."
      },
      "gaps": [
        {
          "field": "incomeLimit.tables",
          "reason": "The source also prints a 165% table for an elderly or disabled member who buys and cooks apart and is counted as a separate household. It is not a limit for the household applying, so it is left out."
        },
        {
          "field": "incomeLimit",
          "reason": "The ACIN publishes no separate gross table for households with a member 60 or older or disabled and does not say on this page whether those households skip the gross test, so no table with an elderlyOrDisabled condition is given. The 165% table is for an elderly or disabled person who is a separate household, which the notice does not define and a resident would not know to say, so it has no when."
        },
        {
          "field": "netIncomeLimit",
          "reason": "The ACIN does not say which households must pass the net test (for example whether MCE/BBCE households are exempt), so the single net table carries no group."
        }
      ]
    },
    "medicaid": {
      "state": "CA",
      "program": "medicaid",
      "name": {
        "value": "Medi-Cal",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "Medi-Cal is California's Medicaid program. It gives free or low-cost health insurance to Californians with limited incomes."
      },
      "agency": {
        "value": "California Department of Health Care Services (DHCS); county offices handle cases",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "Medi-Cal is run by the California Department of Health Care Services (DHCS), not Covered California."
      },
      "covers": {
        "value": "Free or low-cost health insurance for Californians with limited incomes, including health, dental and vision care.",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "Medi-Cal covers health, dental and vision care for you and your children, often at little or no cost."
      },
      "incomeLimit": {
        "value": {
          "year": "Program Eligibility by Federal Poverty Level for 2027 (Covered California chart dated 10/2026); Medi-Cal monthly values sourced to DHCS ACWDL 26-01",
          "basis": "Medi-Cal for Adults, up to 138% of the federal poverty level, using the chart's DHCS monthly 138% column. The chart does not name the income measure or say whether a 5% disregard is included; magi is set because Covered California's own Medi-Cal training lists Adults Expansion (ages 19 to 64, 138% FPL) as a Modified Adjusted Gross Income (MAGI) Medi-Cal group. The same chart lists children up to 266% FPL and pregnant individuals up to 213% FPL.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "adults (Medi-Cal for Adults, 138% FPL)",
              "bySize": [
                1836,
                2490,
                3143,
                3795,
                4450,
                5102,
                5755,
                6409
              ],
              "eachAdditional": 655
            }
          ]
        },
        "sourceUrl": "https://www.coveredca.com/pdfs/FPL-chart.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Medi-Cal monthly values are provided above, for reference. Source: DHCS ACWDL 26-01"
      },
      "apply": {
        "value": "Apply any time of year online with the single Covered California application, which checks Medi-Cal and Covered California eligibility at once; you can also call Covered California at (800) 300-1506 or call or visit your county Medi-Cal office.",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "Call or visit a Medi-Cal office in your county."
      },
      "phone": {
        "value": "(800) 300-1506",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "Call Covered California at (800) 300-1506."
      },
      "website": {
        "value": "https://www.coveredca.com/coverage-basics/medi-cal",
        "sourceUrl": "https://www.coveredca.com/coverage-basics/medi-cal",
        "checkedAt": "2026-10-30",
        "quote": "One application checks your eligibility for both Medi-Cal and Covered California."
      },
      "gaps": [
        {
          "field": "renewal",
          "reason": "dhcs.ca.gov (every page and PDF tried, including sps2016.dhcs.ca.gov) returns an Incapsula bot-check page instead of content, so no DHCS renewal page could be read. The Covered California Medi-Cal and Losing Medi-Cal Coverage pages do not state a renewal cycle, and the CDSS H.R. 1 FAQ only refers readers to DHCS for Medi-Cal changes."
        },
        {
          "field": "incomeLimit",
          "reason": "The fact's source chart does not name the income measure (MAGI) or say whether the 138% column includes the 5% disregard; magi rests on a separate 2018 Covered California training document (hbex.coveredca.com Medi-Cal-Application-Eligibility-and-Enrollment-Process.pdf). DHCS pages, including ACWDL 26-01, could not be read because dhcs.ca.gov blocks scripted fetches. The pregnant individuals column (213% FPL) is not included as a table because there is no when key for pregnancy."
        }
      ]
    },
    "liheap": {
      "state": "CA",
      "program": "liheap",
      "name": {
        "value": "Low Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://www.csd.ca.gov/Pages/LIHEAPProgram.aspx",
        "checkedAt": "2026-10-30",
        "quote": "The Low Income Home Energy Assistance Program (LIHEAP) provides assistance to eligible low-income households"
      },
      "agency": {
        "value": "California Department of Community Services and Development (CSD), through local service providers",
        "sourceUrl": "https://www.csd.ca.gov/Pages/Contact-Us.aspx",
        "checkedAt": "2026-10-30",
        "quote": "Our Call Center answers questions about all CSD assistance programs, including the Low Income Home Energy Assistance Program (LIHEAP)."
      },
      "covers": {
        "value": "A one-time payment toward heating or cooling bills (including wood, propane or oil), help in an energy crisis such as a utility disconnection, and free weatherization upgrades.",
        "sourceUrl": "https://www.csd.ca.gov/energybills",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP is a federally funded program that helps low-income households pay for heating or cooling in their homes."
      },
      "incomeLimit": {
        "value": {
          "year": "2026 LIHEAP Income Eligibility",
          "basis": "CSD's 2026 LIHEAP monthly income limits by household size, one table for all households. The page does not say gross or net; CSD's Draft 2027 LIHEAP State Plan (a separate document) says gross income and a 60% of State Median Income threshold.",
          "period": "monthly",
          "measuredOn": "unstated",
          "tables": [
            {
              "appliesTo": "all households",
              "bySize": [
                3331.66,
                4356.83,
                5382,
                6407.16,
                7432.25,
                8457.41,
                8649.66,
                8841.83,
                9034.08,
                9226.25
              ],
              "eachAdditional": 192.21
            }
          ]
        },
        "sourceUrl": "https://www.csd.ca.gov/Pages/LIHEAP-Income-Eligibility.aspx",
        "checkedAt": "2026-10-30",
        "quote": "Eligibility for services may vary depending on sources of income and other factors."
      },
      "renewal": {
        "value": "LIHEAP is not an ongoing enrolled benefit: CSD's Draft 2027 State Plan lets a provider give an eligible household one HEAP or ECIP Fast Track payment per program year, with supplemental payments only in extenuating circumstances.",
        "sourceUrl": "https://www.csd.ca.gov/Shared%20Documents/2027-Draft-LIHEAP-State-Plan.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Contractor may only provide eligible households with one ECIP Fast Track/WPO, or HEAP/WPO payment per program year."
      },
      "apply": {
        "value": "Apply through your local LIHEAP service provider, found with CSD's Find Services in Your Area search by city or ZIP code; CSD's call center at (866) 675-6623 also answers LIHEAP questions. Funding is limited and providers prioritize the most vulnerable households.",
        "sourceUrl": "https://www.csd.ca.gov/energybills",
        "checkedAt": "2026-10-30",
        "quote": "please contact your local service provider by visiting Find Services in Your Area and selecting the Energy Bill Assistance and Weatherization Provider in your City or County."
      },
      "phone": {
        "value": "(866) 675-6623",
        "sourceUrl": "https://www.csd.ca.gov/Pages/Contact-Us.aspx",
        "checkedAt": "2026-10-30",
        "quote": "Call toll free: (866) 675-6623"
      },
      "website": {
        "value": "https://www.csd.ca.gov/energybills",
        "sourceUrl": "https://www.csd.ca.gov/energybills",
        "checkedAt": "2026-10-30",
        "quote": "Behind on your energy bills? LIHEAP may be able to help."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The CSD income page does not state gross or net income, so measuredOn is unstated; only the separate Draft 2027 State Plan says gross. No 2027 LIHEAP dollar table was found; the page still shows the 2026 table."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "benefitscal.com",
      "sourceUrl": "https://www.cdss.ca.gov/benefits-services/food-nutrition-services/calfresh/frequently-asked-questions",
      "checkedAt": "2026-10-30",
      "quote": "You can apply online at BenefitsCal.com."
    },
    {
      "host": "coveredca.com",
      "sourceUrl": "https://www.ca.gov/departments/240/",
      "checkedAt": "2026-10-30",
      "quote": "Apply for Medical Insurance via Covered California"
    }
  ]
};
