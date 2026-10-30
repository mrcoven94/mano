import type { StateCatalog } from "../types.js";

export const NY: StateCatalog = {
  "state": "NY",
  "programs": {
    "snap": {
      "state": "NY",
      "program": "snap",
      "name": {
        "value": "Supplemental Nutrition Assistance Program (SNAP)",
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "The Supplemental Nutrition Assistance Program (SNAP) issues electronic benefits that can be used like cash to purchase food."
      },
      "agency": {
        "value": "New York State Office of Temporary and Disability Assistance (OTDA); applications are handled by local departments of social services",
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "EBT is the method by which the OTDA delivers cash and Supplemental Nutrition Assistance Program (SNAP) benefits"
      },
      "covers": {
        "value": "Monthly benefits on an EBT card that can be used to buy food at authorized retail food stores.",
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "SNAP monthly benefits can be used to purchase food at authorized retail food stores."
      },
      "incomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027); NY charts say SNAP Standards effective October 1, 2026",
          "basis": "Gross monthly limit for households without earned income and with no member 60 or older or disabled; the figures equal the federal 130% FPL limit. NY publishes higher gross limits on the same page: households with earned income (no member 60+ or disabled) 1995, 2705, 3415, 4125, 4835, 5545, 6255, 6965, each additional 710; households with a member 60 or older or disabled, or with dependent care expenses, 2660, 3607, 4553, 5500, 6447, 7393, 8340, 9287, each additional 947. Meeting the gross limit does not guarantee eligibility.",
          "period": "monthly",
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
        },
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "Income Guidelines for Households without Earned Income (no member 60 years or older nor disabled member)"
      },
      "renewal": {
        "value": "Households recertify at the end of each certification period: a recertification packet with an application and a scheduled phone interview arrives about two months before the period ends, and the household must submit the application and then complete the interview. OTDA's pages do not state the length of the certification period.",
        "sourceUrl": "https://otda.ny.gov/programs/snap/recertification-faqs.asp",
        "checkedAt": "2026-10-30",
        "quote": "Approximately two months before your SNAP certification period ends, you will receive a recertification packet in the mail"
      },
      "apply": {
        "value": "Apply online at myBenefits.ny.gov, in person at your local department of social services (a SNAP Center in New York City), or print the SNAP application and mail or fax it to your local department of social services.",
        "sourceUrl": "https://otda.ny.gov/programs/apply/",
        "checkedAt": "2026-10-30",
        "quote": "Print and mail or fax the SNAP Application form to your local department of social services."
      },
      "phone": {
        "value": "1-800-342-3009",
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "For more information about SNAP, contact your local department of social services or call the toll-free OTDA Hotline: 1-800-342-3009."
      },
      "website": {
        "value": "https://mybenefits.ny.gov/mybenefits/begin",
        "sourceUrl": "https://otda.ny.gov/programs/snap/",
        "checkedAt": "2026-10-30",
        "quote": "Find out if you may be eligible and apply for SNAP."
      },
      "gaps": [
        {
          "field": "netIncomeLimit",
          "reason": "OTDA's SNAP page, SNAP FAQ (qanda.asp) and recertification FAQ publish only gross income charts and never state a net income test or net limit for New York households; not filled from the federal table because NY's use of it is not stated on a fetched page."
        },
        {
          "field": "renewalLength",
          "reason": "Value is recorded, but the length of the SNAP certification period (for example 12 or 24 months) is not stated on the OTDA SNAP page or recertification FAQ."
        }
      ]
    },
    "medicaid": {
      "state": "NY",
      "program": "medicaid",
      "name": {
        "value": "New York State Medicaid",
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/",
        "checkedAt": "2026-10-30",
        "quote": "New York's Medicaid program provides comprehensive health coverage to more than 7.5 million New Yorkers"
      },
      "agency": {
        "value": "New York State Department of Health",
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/",
        "checkedAt": "2026-10-30",
        "quote": "New York State Department of Health Launches State Medicaid Health Equity Regional Organization (HERO) Initiative"
      },
      "covers": {
        "value": "Comprehensive health coverage that pays for a wide range of medical services, used through a Medicaid card or a managed care plan; some services have small co-payments that can be waived if you cannot afford them.",
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/",
        "checkedAt": "2026-10-30",
        "quote": "Medicaid pays for a wide-range of services, depending on your age, financial circumstances, family situation, or living arrangements."
      },
      "incomeLimit": {
        "value": {
          "year": "2026 (2026 federal poverty levels; DOH MAGI income standards effective January 1, 2026)",
          "basis": "138% of the federal poverty level, adults 19 to 64 (Medicaid expansion, MAGI rules). Children 1 to 18 qualify up to 154% FPL, 19 and 20 year olds living with a parent up to 155%, pregnant women and infants up to 223%.",
          "period": "monthly",
          "bySize": [
            1836,
            2489,
            3142,
            3795,
            4449,
            5102,
            5755,
            6408
          ],
          "eachAdditional": 654
        },
        "sourceUrl": "https://info.nystateofhealth.ny.gov/sites/default/files/2026%20Income%20Levels_for%20Medicaid,%20CHPlus%20&%20EP.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Adults: Up to 138% FPL"
      },
      "renewal": {
        "value": "Coverage is renewed once a year today, and NY State of Health sends a renewal notice when it is time. Starting January 1, 2027, most adults 19 to 64 must renew every 6 months: people who apply before January 1, 2027 or renew before March 1, 2027 get 12 months first, then renew every 6 months. American Indian and Alaska Native adults, children and people with disabilities still renew once a year.",
        "sourceUrl": "https://info.nystateofhealth.ny.gov/stay-covered",
        "checkedAt": "2026-10-30",
        "quote": "Starting January 1, 2027, most adults aged 19-64 must renew their Medicaid every 6 months, instead of once a year."
      },
      "apply": {
        "value": "Most people, including adults 19 to 64, apply through NY State of Health online, by phone at (855) 355-5777, or with a free enrollment assistor. Some groups, such as people receiving SSI or seeking community based long-term care, apply through their local department of social services (the Human Resources Administration in New York City).",
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/how_do_i_apply.htm",
        "checkedAt": "2026-10-30",
        "quote": "Where you apply for Medicaid will depend on your category of eligibility."
      },
      "phone": {
        "value": "(800) 541-2831",
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/",
        "checkedAt": "2026-10-30",
        "quote": "Toll Free: (800) 541-2831"
      },
      "website": {
        "value": "https://nystateofhealth.ny.gov/",
        "sourceUrl": "https://info.nystateofhealth.ny.gov/how-renew-your-health-insurance",
        "checkedAt": "2026-10-30",
        "quote": "You can complete your renewal online by logging into your account at nystateofhealth.ny.gov."
      },
      "gaps": []
    },
    "liheap": {
      "state": "NY",
      "program": "liheap",
      "name": {
        "value": "Home Energy Assistance Program (HEAP)",
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "The Home Energy Assistance Program (HEAP) can help eligible New Yorkers heat and cool their homes."
      },
      "agency": {
        "value": "New York State Office of Temporary and Disability Assistance (OTDA), through HEAP Local District Contacts (local departments of social services)",
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "Questions regarding the HEAP program should be directed to your HEAP Local District Contact or the OTDA Hotline at 1-800-342-3009."
      },
      "covers": {
        "value": "Helps pay for heating the home, with one Regular benefit per program year paid to the heating vendor, plus emergency benefits when heat is shut off or fuel runs out, heating equipment repair or replacement, clean and tune services, and cooling assistance.",
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "If you are eligible, you may receive one Regular HEAP benefit per program year to help you pay for heating your home."
      },
      "incomeLimit": {
        "value": {
          "year": "2026-2027 HEAP program year",
          "basis": "Maximum gross monthly household income. Households receiving SNAP, federally funded Temporary Assistance or Code A SSI (living alone) can also qualify. The table continues: 9 people 9662, 10 people 9867, 11 people 10073, 12 people 10278, 13 people 10515, then add 710 for each additional person beyond 13 (so eachAdditional is not given for sizes 9 to 13).",
          "period": "monthly",
          "bySize": [
            3563,
            4659,
            5756,
            6852,
            7948,
            9045,
            9250,
            9456
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "Your total household gross monthly income for your household size must be at or below the following guidelines:"
      },
      "renewal": {
        "value": "HEAP does not renew automatically: a household can get one Regular benefit per program year and applies again each program year while HEAP is open. The 2026-2027 Regular benefit is scheduled to open November 2, 2026, and Emergency HEAP on January 4, 2027.",
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "The 2026-2027 Regular HEAP benefit is scheduled to open November 2, 2026."
      },
      "apply": {
        "value": "When HEAP is open, apply online at myBenefits.ny.gov (outside New York City) or ACCESS HRA (New York City), in person at your HEAP Local District Contact, or by mailing or dropping off the HEAP application (LDSS-3421). Emergency benefits require contacting your HEAP Local District Contact.",
        "sourceUrl": "https://otda.ny.gov/programs/apply/",
        "checkedAt": "2026-10-30",
        "quote": "You can download and print the HEAP Application (LDSS-3421) or call your HEAP Local District Contact to request an application be mailed to your home."
      },
      "phone": {
        "value": "1-800-342-3009",
        "sourceUrl": "https://otda.ny.gov/programs/heap/",
        "checkedAt": "2026-10-30",
        "quote": "Questions regarding the HEAP program should be directed to your HEAP Local District Contact or the OTDA Hotline at 1-800-342-3009."
      },
      "website": {
        "value": "https://mybenefits.ny.gov/mybenefits/begin",
        "sourceUrl": "https://otda.ny.gov/programs/apply/",
        "checkedAt": "2026-10-30",
        "quote": "Outside of New York City"
      },
      "gaps": [
        {
          "field": "regularBenefitOpenDate",
          "reason": "OTDA's apply page says the 2026-2027 Regular HEAP benefit 'opened November 2, 2026' while the HEAP page says it 'is scheduled to open November 2, 2026'; as of 2026-10-30 it has not opened yet. The renewal value uses the HEAP page wording."
        }
      ]
    }
  },
  "documentedSites": []
};
