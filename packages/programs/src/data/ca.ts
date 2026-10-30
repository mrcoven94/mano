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
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "Gross monthly limit of 200% of the federal poverty level under California's Modified Categorical Eligibility (CDSS MCE fact sheet). Households that cannot be given MCE status (for example a member disqualified for an intentional program violation) face the 130% federal gross limit instead.",
          "period": "monthly",
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
        "sourceUrl": "https://cdss.ca.gov/portals/9/calfreshoutreach/220000_English_Income_Inserts_FFY2027.pdf",
        "checkedAt": "2026-10-30",
        "quote": "2026-2027 CalFresh Income & Eligibility Limits"
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "Net monthly limit of 100% of the federal poverty level, as published on the CDSS FFY2027 income chart; the chart does not say which households it applies to.",
          "period": "monthly",
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
        },
        "sourceUrl": "https://cdss.ca.gov/portals/9/calfreshoutreach/220000_English_Income_Inserts_FFY2027.pdf",
        "checkedAt": "2026-10-30",
        "quote": "2026-2027 CalFresh Income & Eligibility Limits"
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
      "gaps": []
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
          "year": "Covered California chart for 2027 (dated 10/2026); its Medi-Cal monthly values are sourced to DHCS ACWDL 26-01",
          "basis": "138% of the federal poverty level, Medi-Cal for Adults (the DHCS monthly 138% column). Children qualify up to 266% FPL and pregnant individuals up to 213% FPL on the same chart.",
          "period": "monthly",
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
        },
        "sourceUrl": "https://www.coveredca.com/pdfs/FPL-chart.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Program Eligibility by Federal Poverty Level for 2027"
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
          "year": "2026 LIHEAP program year (latest table CSD publishes)",
          "basis": "CSD's 2026 LIHEAP gross monthly income limits. CSD's Draft 2027 LIHEAP State Plan sets the threshold at 60% of State Median Income for all household sizes and uses gross income. The table also lists 9 people at 9034.08 and 10 people at 9226.25, and adds 192.21 for each person above 10, so there is no single per-person step after 8.",
          "period": "monthly",
          "bySize": [
            3331.66,
            4356.83,
            5382,
            6407.16,
            7432.25,
            8457.41,
            8649.66,
            8841.83
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://www.csd.ca.gov/Pages/LIHEAP-Income-Eligibility.aspx",
        "checkedAt": "2026-10-30",
        "quote": "2026 LIHEAP Income Eligibility"
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
      "gaps": []
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
