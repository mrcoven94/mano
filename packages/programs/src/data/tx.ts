import type { StateCatalog } from "../types.js";

export const TX: StateCatalog = {
  "state": "TX",
  "programs": {
    "snap": {
      "state": "TX",
      "program": "snap",
      "name": {
        "value": "SNAP Food Benefits",
        "sourceUrl": "https://www.yourtexasbenefits.com/Learn/Home",
        "checkedAt": "2026-10-30",
        "quote": "SNAP Food Benefits Helps families buy food for good health."
      },
      "agency": {
        "value": "Texas Health and Human Services Commission (HHSC)",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "The Texas Health and Human Services Commission (HHSC) must accommodate reasonable requests"
      },
      "covers": {
        "value": "Monthly benefits that help households buy food.",
        "sourceUrl": "https://www.yourtexasbenefits.com/Learn/Home",
        "checkedAt": "2026-10-30",
        "quote": "SNAP Food Benefits Helps families buy food for good health."
      },
      "incomeLimit": {
        "value": {
          "year": "Revision 26-4; Effective Oct. 1, 2026",
          "basis": "Texas Works Handbook C-121 SNAP maximum income limits: a 165% FPL column that HHSC says is the income limit for categorically eligible households, and a Gross (130%) column for the gross income test. A-1341 says the gross income test applies to all households except those with a member who is elderly or has a disability, or that are categorically eligible.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "Categorically eligible households (165% FPL column). HHSC also uses this column to decide whether an elderly or disabled person who buys and prepares food with others may be a separate household.",
              "bySize": [
                2195,
                2976,
                3757,
                4538,
                5319,
                6100,
                6881,
                7662,
                8443,
                9224
              ],
              "eachAdditional": 781
            },
            {
              "appliesTo": "Households that are not categorically eligible (Gross 130% column). Households with a member who is elderly or has a disability do not take this gross income test (A-1341).",
              "bySize": [
                1729,
                2345,
                2960,
                3575,
                4191,
                4806,
                5421,
                6037,
                6653,
                7269
              ],
              "eachAdditional": 616
            }
          ]
        },
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/306316",
        "checkedAt": "2026-10-30",
        "quote": "The figures in this column are also the income limits for categorically eligible households."
      },
      "netIncomeLimit": {
        "value": {
          "year": "Revision 26-4; Effective Oct. 1, 2026",
          "basis": "Net (100%) column of the Texas Works Handbook C-121 SNAP maximum income limits. A-1341 says the net income test applies to all households except categorically eligible ones, including a household with an elderly or disabled member whose gross income is over 165% FPL and that is not categorically eligible.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "Households that are not categorically eligible (Net 100% column).",
              "bySize": [
                1330,
                1804,
                2277,
                2750,
                3224,
                3697,
                4170,
                4644,
                5118,
                5592
              ],
              "eachAdditional": 474
            }
          ]
        },
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/306316",
        "checkedAt": "2026-10-30",
        "quote": "SNAP Maximum Income Limits Effective Oct. 1, 2026"
      },
      "renewal": {
        "value": "HHSC gives the longest certification period that fits the household: six months for most households (streamlined reporting), 6 to 12 months for households of only elderly or unemployable people with stable circumstances, and 36 months for TSAP and SNAP-CAP households. A renewal counts as timely if filed by the 15th of the last month of the certification period.",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/4666",
        "checkedAt": "2026-10-30",
        "quote": "If a household meets the SR criteria, assign a six-month certification period."
      },
      "apply": {
        "value": "Apply online at YourTexasBenefits.com, at a local HHSC benefits office, by mail or by fax. You can also apply by phone through 2-1-1.",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "For applications submitted by phone through 2-1-1, the file date is the date the applicant submits the application"
      },
      "phone": {
        "value": "1-877-541-7905",
        "sourceUrl": "https://www.yourtexasbenefits.com/GeneratePDF/StaticPdfs/en_US/H1010_Apr2024_3.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Call 2-1-1 (if you can’t connect, call 1-877-541-7905). After you pick a language, press 2 to:"
      },
      "website": {
        "value": "https://www.yourtexasbenefits.com/Learn/Home",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "The online application on YourTexasBenefits.com integrates HHSC programs into one single application flow."
      },
      "gaps": []
    },
    "medicaid": {
      "state": "TX",
      "program": "medicaid",
      "name": {
        "value": "Texas Medicaid",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/80036",
        "checkedAt": "2026-10-30",
        "quote": "provider enrolls in the Texas Medicaid Program."
      },
      "agency": {
        "value": "Texas Health and Human Services Commission (HHSC)",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "The Texas Health and Human Services Commission (HHSC) must accommodate reasonable requests"
      },
      "covers": {
        "value": "Health coverage that pays for visits to doctors, dentists and hospitals, and for medicines ordered by doctors and dentists.",
        "sourceUrl": "https://www.yourtexasbenefits.com/Learn/Home",
        "checkedAt": "2026-10-30",
        "quote": "Helps cover visits to doctors, dentists, and hospitals. Also covers medicines ordered by doctors and dentists."
      },
      "incomeLimit": {
        "value": {
          "year": "Revision 15-4; Effective October 1, 2015 (still the current C-131.2 table on 2026-10-30)",
          "basis": "Medicaid for Parents and Caretaker Relatives (TP 08) limits in Texas Works Handbook C-131.2, compared with MAGI household income, which A-1341 Step 4 defines as the sum of MAGI individual incomes minus the standard MAGI disregard of five percentage points of FPL (C-131.4, on this page; $113.85 a month for size 3 in 2026). The table does not include the disregard, and the program requires a parent or caretaker relative living with a dependent child (A-240).",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "TP 08 households with one parent or caretaker relative (One Parent column).",
              "bySize": [
                103,
                196,
                230,
                277,
                310,
                356,
                389,
                441,
                476,
                527,
                562,
                613,
                648,
                700,
                734
              ],
              "eachAdditional": 52
            },
            {
              "appliesTo": "TP 08 households with two parents (Two Parents column). The page prints N/A for size 1, shown here as null; rows start at size 2.",
              "bySize": [
                null,
                161,
                251,
                285,
                332,
                367,
                412,
                447,
                500,
                535,
                587,
                622,
                675,
                710,
                762
              ],
              "eachAdditional": 52
            }
          ]
        },
        "sourceUrl": "https://fhb.hhs.texas.gov/handbooks/texas-works-handbook/c-130-medical-programs",
        "checkedAt": "2026-10-30",
        "quote": "Medically Needy and Parents and Caretaker Relatives Medicaid"
      },
      "renewal": {
        "value": "Medicaid for Parents and Caretaker Relatives is certified for 12 months at a time, then renewed.",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/4666",
        "checkedAt": "2026-10-30",
        "quote": "TP 08 has a 12-month non-continuous eligibility certification period."
      },
      "apply": {
        "value": "Apply online at YourTexasBenefits.com, at a local HHSC benefits office, by mail, by fax or by phone.",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "Online through YourTexasBenefits.com; In the local office; By mail; By fax; or By phone."
      },
      "phone": {
        "value": "1-877-541-7905",
        "sourceUrl": "https://www.yourtexasbenefits.com/GeneratePDF/StaticPdfs/en_US/H1010_Apr2024_3.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Call 2-1-1 (if you can’t connect, call 1-877-541-7905). After you pick a language, press 2 to:"
      },
      "website": {
        "value": "https://www.yourtexasbenefits.com/Learn/Home",
        "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
        "checkedAt": "2026-10-30",
        "quote": "YourTexasBenefits.com can be used to apply for the following benefits:"
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "No Medicaid-only application line found. The number given is the HHSC benefits line printed on Form H1010, the state's combined application for SNAP, TANF and Medicaid (also printed on the HHS Lone Star Card contacts page, which returns 403 to scripted fetches). The Statewide Medicaid help line 800-335-8957 (Texas Works Handbook C-1460) is for questions about covered services and bills, not applying."
        },
        {
          "field": "incomeLimit",
          "reason": "The two-parent column prints N/A for household size 1, so that table's first bySize entry is null rather than a number. If the schema requires numbers only, the consumer should treat size 1 as no two-parent limit (a two-parent household has at least two people)."
        }
      ]
    },
    "liheap": {
      "state": "TX",
      "program": "liheap",
      "name": {
        "value": "Comprehensive Energy Assistance Program (CEAP)",
        "sourceUrl": "https://www.tdhca.texas.gov/comprehensive-energy-assistance-program-ceap",
        "checkedAt": "2026-10-30",
        "quote": "The Comprehensive Energy Assistance Program (CEAP) is a utility assistance program."
      },
      "agency": {
        "value": "Texas Department of Housing and Community Affairs (TDHCA), through local provider organizations (subrecipients) that cover all 254 counties",
        "sourceUrl": "https://www.tdhca.texas.gov/help-for-texans",
        "checkedAt": "2026-10-30",
        "quote": "TDHCA assistance and funds go to local provider organizations, NOT individuals directly."
      },
      "covers": {
        "value": "Help paying home energy (utility) bills for low-income households, plus energy education to lower future bills.",
        "sourceUrl": "https://www.tdhca.texas.gov/comprehensive-energy-assistance-program-ceap",
        "checkedAt": "2026-10-30",
        "quote": "CEAP is designed to assist low income households in meeting their immediate energy needs"
      },
      "incomeLimit": {
        "value": {
          "year": "Program Year 2026 (Effective January 26, 2026)",
          "basis": "TDHCA calculates CEAP eligibility at 150% of the federal poverty income guidelines; the page does not say whether income is gross or net.",
          "period": "annual",
          "measuredOn": "unstated",
          "tables": [
            {
              "appliesTo": "All CEAP households (150% of Federal Poverty Income Limits column).",
              "bySize": [
                23940,
                32460,
                40980,
                49500,
                58020,
                66540,
                75060,
                83580
              ],
              "eachAdditional": 8520
            }
          ]
        },
        "sourceUrl": "https://www.tdhca.texas.gov/community-affairs-income-guidelines",
        "checkedAt": "2026-10-30",
        "quote": "Program Year 2026 Federal Poverty Income Guidelines (FPIG)"
      },
      "renewal": {
        "value": "CEAP runs by program year starting January 1; benefit allowances start over each January 1, so households apply again each program year, and local providers may let returning clients use a shorter application with updated income documents.",
        "sourceUrl": "https://www.tdhca.texas.gov/sites/default/files/community-affairs/ceap/docs/CEAP-FAQ.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Benefit allowances start over January 1 of every program year regardless of what the"
      },
      "apply": {
        "value": "TDHCA does not take applications from individuals. Apply with the local CEAP provider for your area, found on TDHCA's Help for Texans page by choosing Utility Bill Payment Help and entering your city or county.",
        "sourceUrl": "https://www.tdhca.texas.gov/help-for-texans",
        "checkedAt": "2026-10-30",
        "quote": "TDHCA does not accept applications from individuals."
      },
      "website": {
        "value": "https://www.tdhca.texas.gov/help-for-texans",
        "sourceUrl": "https://www.tdhca.texas.gov/comprehensive-energy-assistance-program-ceap",
        "checkedAt": "2026-10-30",
        "quote": "If you or someone you know is in need of assistance, please visit our Help for Texans Page."
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "TDHCA prints no statewide CEAP phone line; applications go through local providers, each with its own number. The Help for Texans page points to Texas 2-1-1 (Texas Information and Referral Network) as a general referral resource, not a CEAP line."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "www.yourtexasbenefits.com",
      "sourceUrl": "https://fhb.hhs.texas.gov/book/export/html/264521",
      "checkedAt": "2026-10-30",
      "quote": "The online application on YourTexasBenefits.com integrates HHSC programs into one single application flow."
    }
  ]
};
