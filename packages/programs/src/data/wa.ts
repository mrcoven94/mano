import type { StateCatalog } from "../types.js";

export const WA: StateCatalog = {
  "state": "WA",
  "programs": {
    "snap": {
      "state": "WA",
      "program": "snap",
      "name": {
        "value": "Basic Food",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "Basic Food is Washington’s name for the federally funded food assistance program, also known as the Supplemental Nutrition Assistance Program or SNAP."
      },
      "agency": {
        "value": "Washington State Department of Social and Health Services (DSHS)",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "In person at your local DSHS Community Services Office."
      },
      "covers": {
        "value": "Monthly benefits loaded on an EBT card that low-income households use to buy food.",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "This program provides food benefits to low-income households to supplement their grocery budget."
      },
      "incomeLimit": {
        "value": {
          "year": "April 1, 2026 to March 31, 2027 (200 percent of Federal Poverty Guidelines published January 2026)",
          "basis": "Washington uses broad-based categorical eligibility (CE): an assistance unit with gross countable income at or under 200% FPL skips the gross income, net income and resource tests. Units that cannot be CE (a member disqualified for an intentional program violation, a substantial lottery or gambling win, or a head of household disqualified for work requirements) must meet the regular tests instead.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "all assistance units that can be categorically eligible (every household except those named in the next table)",
              "bySize": [
                2660,
                3607,
                4553,
                5500,
                6447,
                7393,
                8340,
                9287,
                10233,
                11180
              ],
              "eachAdditional": 947
            },
            {
              "appliesTo": "assistance units that cannot be categorically eligible (IPV disqualification, substantial lottery or gambling win, or head of household disqualified for work requirements); the state sets 130% of the federal poverty level for them, and the amounts are the federal FY2027 130% table",
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
              "eachAdditional": 616,
              "source": {
                "sourceUrl": "https://www.fna.usda.gov/snap/allotment/cola",
                "checkedAt": "2026-10-30",
                "quote": "Table 2. Gross Monthly Income Limit (130% of Federal Poverty Level)"
              }
            }
          ]
        },
        "sourceUrl": "https://www.dshs.wa.gov/categorical-eligibility-basic-food",
        "checkedAt": "2026-10-30",
        "quote": "200 percent of Federal Poverty (FPL) based on Federal Poverty Guidelines published January 2026."
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY 2027 (effective Oct. 1, 2026, through Sept. 30, 2027)",
          "basis": "Federal net income limit at 100% of the federal poverty level, 48 states column. In Washington it applies only to assistance units that cannot be categorically eligible; CE units skip the net income test.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "assistance units that cannot be categorically eligible (CE units skip this test)",
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
        "sourceUrl": "https://www.fna.usda.gov/snap/allotment/cola",
        "checkedAt": "2026-10-30",
        "quote": "Table 1. Net Monthly Income Limit (100% of Federal Poverty Level)"
      },
      "renewal": {
        "value": "Benefits are usually approved for 12 months. Most households also send a mid-certification review in month 6, and DSHS mails an eligibility review form near the end of the 12 months; most food eligibility reviews need an interview.",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits/basic-food-faqs",
        "checkedAt": "2026-10-30",
        "quote": "Basic Food benefits are generally approved for 12 months."
      },
      "apply": {
        "value": "Apply online at Washington Connection, by phone at 877-501-2233, in person at a DSHS Community Services Office, or by mail to the DSHS Customer Service Center, P.O. Box 11699, Tacoma, WA 98411-6699. An interview is required.",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "Online at www.washingtonconnection.org."
      },
      "phone": {
        "value": "877-501-2233",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "For more information, call 877-501-2233."
      },
      "website": {
        "value": "https://www.washingtonconnection.org/",
        "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
        "checkedAt": "2026-10-30",
        "quote": "Online at www.washingtonconnection.org."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The non-CE table has no dollar amounts. DSHS's Basic Food standards page (dshs.wa.gov/basic-food) says the gross standard is 130% FPL but prints no table, and WAC 388-478-0060 still shows the FY 2026 table effective 10/1/2025. FNS publishes FY 2027 130% amounts ($1,729 for 1 person, +$616 each) on a different page, so they are not mixed into this fact."
        },
        {
          "field": "incomeLimit",
          "reason": "The 165% standard (WAC 388-478-0060 and FNS Table 3) is left out. It only decides whether a member who is both elderly and disabled and cannot cook can be a separate assistance unit; it is not a limit for the household applying."
        }
      ]
    },
    "medicaid": {
      "state": "WA",
      "program": "medicaid",
      "name": {
        "value": "Apple Health",
        "sourceUrl": "https://www.hca.wa.gov/about-hca/programs-and-initiatives/apple-health-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "In Washington State, Medicaid is called Apple Health."
      },
      "agency": {
        "value": "Washington State Health Care Authority (HCA)",
        "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
        "checkedAt": "2026-10-30",
        "quote": "Copyright © 2026 Washington Health Care Authority"
      },
      "covers": {
        "value": "Free or low-cost health coverage, including preventive care such as cancer screenings, treatment for conditions like diabetes and high blood pressure, and other health care services.",
        "sourceUrl": "https://www.hca.wa.gov/about-hca/programs-and-initiatives/apple-health-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Apple Health provides preventative care, like cancer screenings, treatment for diabetes and high blood pressure, and many other health care services."
      },
      "incomeLimit": {
        "value": {
          "year": "October 1, 2026",
          "basis": "138% FPL, New Adult group (N05), the Medicaid expansion group for adults 19 to 64. HCA's chart says these MAGI limits already include the 5% income disregard.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "adults 19 to 64 in the New Adult group (N05)",
              "bySize": [
                1835,
                2490,
                3142,
                3795,
                4449,
                5102,
                5755,
                6409,
                7061,
                7714
              ],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://www.hca.wa.gov/assets/free-or-low-cost/income-standards.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Above MAGI limits include 5% income disregard except for Family-related N01."
      },
      "renewal": {
        "value": "Coverage must be renewed every 12 months today. Starting January 1, 2027, people in Apple Health for Adults must renew every 6 months because of H.R. 1. If coverage lapses and the person is found eligible within 90 days, HCA covers the gap.",
        "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
        "checkedAt": "2026-10-30",
        "quote": "Beginning January 1, 2027, people enrolled in Apple Health for Adults will be required to renew their coverage every six months instead of every twelve months."
      },
      "apply": {
        "value": "Adults 19 to 64, children, parents and pregnant people apply or renew online at Washington Healthplanfinder, by phone at 1-855-923-4633, on paper (form 18-001P), or in person with local enrollment help. People 65 or older, blind or disabled apply for Classic Medicaid through Washington Connection or by calling 1-877-501-2233.",
        "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
        "checkedAt": "2026-10-30",
        "quote": "Apply for or renew your Apple Health coverage online through Washington Healthplanfinder™ if you are:"
      },
      "phone": {
        "value": "1-855-923-4633",
        "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
        "checkedAt": "2026-10-30",
        "quote": "Phone: Call the Washington Healthplanfinder™ Customer Support Center at 1-855-923-4633."
      },
      "website": {
        "value": "https://www.wahealthplanfinder.org/",
        "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
        "checkedAt": "2026-10-30",
        "quote": "Online: Go to Washington Healthplanfinder™ – select the \"Let's get started\" button."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "eachAdditional is null. The chart's '11-person+ Household' column shows $654 for N05, which matches the $653 step from 9 to 10 people, but the chart does not say it is added per person past 10."
        },
        {
          "field": "incomeLimit",
          "reason": "The same chart publishes Family N01 (parents and caretakers, $511 for 1 person, no 5% disregard) and Pregnancy and After Pregnancy Coverage (215% FPL) limits. They are left out because they are not the adults 19 to 64 group and pregnancy cannot be expressed with the allowed 'when' keys."
        }
      ]
    },
    "liheap": {
      "state": "WA",
      "program": "liheap",
      "name": {
        "value": "Low-Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "Commerce’s Low-Income Home Energy Assistance Program (LIHEAP) aims to help low-income households in Washington state receive affordable, dependable utility services and avoid disconnection."
      },
      "agency": {
        "value": "Washington State Department of Commerce, delivered through local community action agencies and partners",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP provides energy assistance to households in Washington through a network of community action agencies and local partners."
      },
      "covers": {
        "value": "Mainly a one-time yearly heating grant paid directly to the household's energy company for any fuel type; it also covers cooling and, in some cases, repair or replacement of an unsafe or broken heating or cooling system.",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP is primarily used to assist households with a one-time heating grant made directly to your energy provider."
      },
      "incomeLimit": {
        "value": {
          "year": "PY27, the program year from October 1, 2026 to September 30, 2027",
          "basis": "Household average monthly income at or below 150% of the federal poverty guidelines (FPG). The local LIHEAP provider calculates actual income and allows various deductions and exclusions.",
          "period": "monthly",
          "measuredOn": "unstated",
          "tables": [
            {
              "appliesTo": "all households",
              "bySize": [
                1995,
                2705,
                3415,
                4125,
                4835,
                5545,
                6255,
                6965,
                7675,
                8385,
                9095,
                9805
              ],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://deptofcommerce.box.com/shared/static/3fp0xz4y2x2p4hedw9ww4sk7ma36srlx.pdf",
        "checkedAt": "2026-10-30",
        "quote": "The household’s average monthly income is at or below 150% of the federal poverty guidelines (FPG)."
      },
      "renewal": {
        "value": "There is no renewal; a household can get one LIHEAP grant per program year (October 1 to September 30) and applies again each year.",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "You can apply for LIHEAP once each program year. The program year runs from October 1 through September 30."
      },
      "apply": {
        "value": "Schedule an appointment with the LIHEAP provider for your county, found with Commerce's LIHEAP map tool; each agency has its own scheduling process, and Commerce itself does not take applications or schedule appointments.",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "To apply for energy assistance, you must schedule an appointment with an organization that offers services in your area."
      },
      "phone": {
        "value": "360-725-2857",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP@commerce.wa.gov Phone: 360-725-2857"
      },
      "website": {
        "value": "https://fortress.wa.gov/com/liheappublic/map.aspx",
        "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
        "checkedAt": "2026-10-30",
        "quote": "Use the LIHEAP public map tool to view and select the county you live in."
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "This is the Commerce LIHEAP program office contact, not an application line. Commerce does not take applications; each county provider has its own number, found only through the map tool."
        },
        {
          "field": "incomeLimit",
          "reason": "eachAdditional is null: the PY27 chart stops at 12 people and states no per-person amount past 12. The chart says 'average monthly income' with deductions and exclusions, not gross income, so measuredOn is unstated."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "www.washingtonconnection.org",
      "sourceUrl": "https://www.dshs.wa.gov/family-food-and-housing-services/food-assistance/basic-food-benefits",
      "checkedAt": "2026-10-30",
      "quote": "Online at www.washingtonconnection.org."
    },
    {
      "host": "www.wahealthplanfinder.org",
      "sourceUrl": "https://www.hca.wa.gov/free-or-low-cost-health-care/apply-or-renew-coverage",
      "checkedAt": "2026-10-30",
      "quote": "Apply for or renew your Apple Health coverage online through Washington Healthplanfinder™ if you are:"
    },
    {
      "host": "deptofcommerce.box.com",
      "sourceUrl": "https://www.commerce.wa.gov/community-opportunities/liheap/",
      "checkedAt": "2026-10-30",
      "quote": "Download eligibility guidelines for LIHEAP energy assistance (PDF)."
    }
  ]
};
