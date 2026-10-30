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
          "year": "SNAP Standards effective October 1, 2026",
          "basis": "OTDA publishes three gross monthly income charts by household type: households without earned income, households with earned income (both with no member 60 or older or disabled), and households with a member 60 or older or disabled or with dependent care expenses. The page gives dollar amounts only, and says meeting the chart does not ensure eligibility.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "households without earned income, with no member 60 or older or disabled, and without dependent care expenses (households with dependent care expenses use the third chart)",
              "when": [
                {
                  "earnedIncome": false,
                  "elderlyOrDisabled": false,
                  "dependentCare": false
                }
              ],
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
            {
              "appliesTo": "households with earned income, with no member 60 or older or disabled, and without dependent care expenses (households with dependent care expenses use the third chart)",
              "when": [
                {
                  "earnedIncome": true,
                  "elderlyOrDisabled": false,
                  "dependentCare": false
                }
              ],
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
              "eachAdditional": 710
            },
            {
              "appliesTo": "households with a member 60 or older or a disabled member, and households with dependent care expenses",
              "when": [
                {
                  "elderlyOrDisabled": true
                },
                {
                  "dependentCare": true
                }
              ],
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
              "eachAdditional": 947
            }
          ]
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
          "field": "renewalLength",
          "reason": "Value is recorded, but the length of the SNAP certification period (for example 12 or 24 months) is not stated on the OTDA SNAP page or recertification FAQ."
        },
        {
          "field": "incomeLimit",
          "reason": "Not a missing fact, a known limit left out: GIS 26 DC 045 also lists 165% FPL (2195, 2976, 3757, 4538, 5319, 6100, 6881, 7662, each additional 781), which applies only when an elderly member (60 or older) or a member who cannot buy food or prepare meals because of a disability (with their spouse) applies as a separate food unit. That limit is tested on the income of the other people in the home, which a screen cannot ask about simply. It is not on the SNAP page that holds the three gross charts, so it is not included as a table."
        },
        {
          "field": "areas.New York City.phone",
          "reason": "Not a gap in the value. The DSS OneNumber (718) 557-1399 is printed for questions about a specific SNAP case, and the page sends general SNAP questions to 311. The interview line is a separate number, 718-SNAP-NOW (718-762-7669), on the same page; the HRA interview instructions page prints 929-273-1872 for the same On Demand interview line. No page fetched uses the name 'HRA Infoline'."
        }
      ],
      "netIncomeLimit": {
        "value": {
          "year": "FFY 2027 (SNAP standards effective October 1, 2026)",
          "basis": "OTDA's FFY 2027 SNAP standards message (GIS 26 DC 045, Upstate and New York City) lists Maximum Net Monthly Income at 100% of the federal poverty level. It does not say which households must pass a net income test; it says households of three or more must also have net income that works out to a positive allotment after the applicable gross and/or net tests.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "households that are subject to a net income test; the source does not say which households these are",
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
        "sourceUrl": "https://otda.ny.gov/policy/gis/2026/26DC045.pdf",
        "checkedAt": "2026-10-30",
        "quote": "The purpose of this release is to describe the annual changes to SNAP standard values for"
      },
      "areas": [
        {
          "area": "New York City",
          "places": [
            "new york city",
            "nyc",
            "new york ny",
            "manhattan",
            "brooklyn",
            "queens",
            "the bronx",
            "bronx",
            "staten island",
            "new york county",
            "kings county",
            "queens county",
            "bronx county",
            "richmond county"
          ],
          "facts": {
            "apply": {
              "value": "In New York City, SNAP is run by the Human Resources Administration (HRA). Apply online on ACCESS HRA (the best option), in person at a SNAP center or with a community-based partner organization, or print the application and mail or fax it. After applying you must complete an interview, by phone on the SNAP on demand line or in person at a SNAP center.",
              "sourceUrl": "https://www.nyc.gov/main/services/snap-benefits",
              "checkedAt": "2026-10-30",
              "quote": "In New York City, SNAP is administered by the Human Resources Administration (HRA)."
            },
            "renewal": {
              "value": "HRA mails a notice when it is time to recertify, and ACCESS HRA shows the case as Expiring Soon. Submit a recertification form (best on the ACCESS HRA website or app; also by mail or in person at a SNAP center), complete an interview and submit required documents. You can recertify as early as 60 days before the certification period ends, and periods in NYC are usually one year. Some seniors and people with disabilities may recertify by phone if HRA mails them instructions.",
              "sourceUrl": "https://www.nyc.gov/main/services/snap-benefits",
              "checkedAt": "2026-10-30",
              "quote": "Certification periods in NYC are usually one year long."
            },
            "website": {
              "value": "https://a069-access.nyc.gov/accesshra/",
              "sourceUrl": "https://www.nyc.gov/main/services/snap-benefits",
              "checkedAt": "2026-10-30",
              "quote": "Submit your recertification form using the ACCESS HRA website or mobile app."
            },
            "phone": {
              "value": "(718) 557-1399",
              "sourceUrl": "https://www.nyc.gov/main/services/snap-benefits",
              "checkedAt": "2026-10-30",
              "quote": "DSS OneNumber (718) 557-1399"
            }
          }
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
          "year": "Effective January 1, 2026 (2026 federal poverty levels, GIS 26 MA/05 attachment)",
          "basis": "138% of the federal poverty level for adults in the MAGI population: single adults and childless couples, parents and caretaker relatives, and 19 and 20 year olds living alone, from the DOH chart New York State Income Standards for MAGI Population. The table is labeled 138% FPL and the page does not mention a separate 5% disregard, so these are the figures to compare with MAGI as published. The same page lists 155% FPL for 19 and 20 year olds living with parents and 223% FPL for pregnant people; its category chart also shows a 100% FPL line for single and childless couples without saying what it applies to.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "adults 19 to 64 (single adults and childless couples, parents and caretaker relatives)",
              "bySize": [
                1836,
                2489,
                3142,
                3795,
                4449,
                5102,
                5755,
                6408,
                7061,
                7715
              ],
              "eachAdditional": 654
            }
          ]
        },
        "sourceUrl": "https://www.health.ny.gov/health_care/medicaid/publications/docs/gis/26ma05_att1.pdf",
        "checkedAt": "2026-10-30",
        "quote": "New York State Income Standards for MAGI Population"
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
          "year": "2026-2027 HEAP Monthly Income Limits",
          "basis": "Maximum gross monthly household income for HEAP. Households that receive SNAP, federally funded Temporary Assistance, or Code A SSI (living alone) can also qualify without meeting this table.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "all households",
              "bySize": [
                3563,
                4659,
                5756,
                6852,
                7948,
                9045,
                9250,
                9456,
                9662,
                9867,
                10073,
                10278,
                10515
              ],
              "eachAdditional": 710
            }
          ]
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
      ],
      "areas": [
        {
          "area": "New York City",
          "places": [
            "new york city",
            "nyc",
            "new york ny",
            "manhattan",
            "brooklyn",
            "queens",
            "the bronx",
            "bronx",
            "staten island",
            "new york county",
            "kings county",
            "queens county",
            "bronx county",
            "richmond county"
          ],
          "facts": {
            "apply": {
              "value": "When the Regular HEAP benefit is open, apply online on ACCESS HRA, in person at a HEAP office or outreach location, or by faxing the HEAP Application (LDSS 3421) to 917-639-2900 or mailing it to Home Energy Assistance Program/HEAP, P.O. Box 1401, Church Street Station, New York, NY 10008. You may be contacted for an eligibility interview, which can be done by phone. Emergency HEAP is applied for by phone through the DSS OneNumber or in person at a HEAP office.",
              "sourceUrl": "https://www.nyc.gov/site/hra/help/energy-assistance.page",
              "checkedAt": "2026-10-30",
              "quote": "You can apply for HEAP Regular benefit online, in person by visiting a HEAP office, or by mail."
            },
            "website": {
              "value": "https://a069-access.nyc.gov/accesshra/",
              "sourceUrl": "https://www.nyc.gov/site/hra/help/energy-assistance.page",
              "checkedAt": "2026-10-30",
              "quote": "Apply online on ACCESS HRA."
            },
            "phone": {
              "value": "718-557-1399",
              "sourceUrl": "https://www.nyc.gov/site/hra/help/energy-assistance.page",
              "checkedAt": "2026-10-30",
              "quote": "You can request an application be mailed to you by calling 718-557-1399"
            }
          }
        }
      ]
    }
  },
  "documentedSites": []
};
