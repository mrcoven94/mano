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
          "year": "April 1, 2026 to March 31, 2027 (200% of the federal poverty guidelines published January 2026)",
          "basis": "200% of the federal poverty level, broad-based categorical eligibility (CE). CE households skip the gross, net and resource tests. Households that cannot be CE (for example an intentional program violation disqualification) face the federal 130% FPL gross test instead.",
          "period": "monthly",
          "bySize": [
            2660,
            3607,
            4553,
            5500,
            6447,
            7393,
            8340,
            9287
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://www.dshs.wa.gov/categorical-eligibility-basic-food",
        "checkedAt": "2026-10-30",
        "quote": "200 percent of Federal Poverty (FPL) based on Federal Poverty Guidelines published January 2026."
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "Federal 100% FPL net standard, which DSHS says Washington uses and updates each October 1. Applies only to households that are not categorically eligible; CE households skip the net income test.",
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
          "field": "incomeLimit.eachAdditional",
          "reason": "The DSHS CE table lists sizes 9 ($10,233) and 10 ($11,180) and says 'Add $947 for each person over 10 AU members'; it states no per-person amount for going from 8 to 9, so eachAdditional is left null rather than inferred."
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
          "year": "HCA income standards effective October 1, 2026",
          "basis": "138% FPL, New Adult group (N05): Medicaid expansion adults 19 to 64. HCA's chart says these MAGI limits include the 5% income disregard.",
          "period": "monthly",
          "bySize": [
            1835,
            2490,
            3142,
            3795,
            4449,
            5102,
            5755,
            6409
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://www.hca.wa.gov/assets/free-or-low-cost/income-standards.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Washington Apple Health Income and Resource Standards October 1, 2026"
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
          "field": "incomeLimit.eachAdditional",
          "reason": "HCA's October 1, 2026 chart lists sizes 1 to 10 and an '11-person+ Household' column of $654 for the adult row; it does not say in words that this is a per-person add-on, so eachAdditional is left null."
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
          "year": "PY27, the LIHEAP program year from October 1, 2026 to September 30, 2027",
          "basis": "150% of the federal poverty guidelines, average monthly household income; the local LIHEAP provider makes the final determination.",
          "period": "monthly",
          "bySize": [
            1995,
            2705,
            3415,
            4125,
            4835,
            5545,
            6255,
            6965
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://deptofcommerce.box.com/shared/static/3fp0xz4y2x2p4hedw9ww4sk7ma36srlx.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Below is a chart of the current income guidelines by household for the current program year."
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
          "field": "incomeLimit.eachAdditional",
          "reason": "The PY27 guidelines chart lists sizes 1 to 12 with no per-person add-on amount stated, so eachAdditional is left null."
        },
        {
          "field": "phone",
          "reason": "This is the Commerce LIHEAP program office contact, not an application line. Commerce does not take applications; each county provider has its own number, found only through the map tool."
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
