import type { StateCatalog } from "../types.js";

export const FL: StateCatalog = {
  "state": "FL",
  "programs": {
    "snap": {
      "state": "FL",
      "program": "snap",
      "name": {
        "value": "Food Assistance Program",
        "sourceUrl": "https://www.fna.usda.gov/snap-directory-entry/florida",
        "checkedAt": "2026-10-30",
        "quote": "Program Name Food Assistance Program"
      },
      "agency": {
        "value": "Florida Department of Children and Families (DCF), Office of Economic Self-Sufficiency",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/supplemental-nutrition-assistance-program-snap",
        "checkedAt": "2026-10-30",
        "quote": "SNAP is a federal program administered by the Florida Department of Children and Families Office of Economic Self-Sufficiency (ESS)."
      },
      "covers": {
        "value": "Benefits on an EBT card to buy food such as bread, cereal, fruit, vegetables, meat, fish, poultry, dairy, and seeds and plants to grow food; not nonfood items, alcohol, tobacco, vitamins, medicine or hot foods.",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/supplemental-nutrition-assistance-program-snap",
        "checkedAt": "2026-10-30",
        "quote": "Households can use food assistance benefits to buy breads, cereals, fruits, vegetables, meats, fish, poultry, dairy, and plants and seeds to grow food for your household to eat."
      },
      "incomeLimit": {
        "value": {
          "year": "FY2027 (Appendix A-1, effective October 1, 2026)",
          "basis": "DCF Appendix A-1 Gross and Net Income Limits, effective October 1, 2026, prints a 200% FPL and a 130% FPL monthly gross column. DCF's SNAP Eligibility page says most households must have gross income at or below 200% FPL; neither page says which households are held to the 130% column.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "Most households (200% FPL gross limit; DCF says most households must meet it)",
              "bySize": [
                2660,
                3608,
                4554,
                5500,
                6448,
                7394,
                8340,
                9288,
                10236,
                11184
              ],
              "eachAdditional": 948
            },
            {
              "appliesTo": "Households held to the 130% FPL gross limit; Appendix A-1 does not say which households these are, so no household should be screened against it until the group is confirmed",
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
        "sourceUrl": "https://ffic.myflfamilies.com/manual/essfiles/31176.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Gross and Net Income Limits Effective October 1, 2026"
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Appendix A-1, effective October 1, 2026)",
          "basis": "100% of the federal poverty level, the Monthly 100% Net Income Limit column of DCF Appendix A-1, effective October 1, 2026. The chart does not say which households must meet the net test.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "Households that must pass the net income test (the chart does not name them)",
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
        "sourceUrl": "https://ffic.myflfamilies.com/manual/essfiles/31176.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Monthly 100% Net Income Limit"
      },
      "renewal": {
        "value": "Most cases are approved for 6 or 12 months; DCF sends a letter when it is time to renew, and the renewal should be completed by the 15th of the month the benefit period ends, even if nothing has changed.",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/economic-self-sufficiency-frequently-asked-questions/",
        "checkedAt": "2026-10-30",
        "quote": "Most cases are approved for either 6 or 12 months. We will send you a letter telling you what to do when it is time for us to review your case."
      },
      "apply": {
        "value": "Apply or renew online in the MyACCESS portal, or in person at a DCF Family Resource Center or Community Partner, or by mailing or faxing a paper application to the ESS Mail Center, P.O. Box 1770, Ocala, FL 34478-1770.",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/supplemental-nutrition-assistance-program-snap",
        "checkedAt": "2026-10-30",
        "quote": "The quickest way to apply for food assistance through DCF is online using the MyACCESS portal."
      },
      "phone": {
        "value": "850-300-4323",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/supplemental-nutrition-assistance-program-snap",
        "checkedAt": "2026-10-30",
        "quote": "If you need help applying or completing your application online, you may call the Customer Contact Center at 850-300-4323."
      },
      "website": {
        "value": "https://myaccess.myflfamilies.com/",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "renew as quickly as possible by going to https://myaccess.myflfamilies.com to update your Medicaid information"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "Appendix A-1 prints a 130% FPL gross column but no fetched DCF page says which households it applies to (the SNAP Eligibility page uses 130% FPL only as the change reporting threshold), so its table has no 'when' and its appliesTo says not to screen against it. The ESS Program Policy Manual index and CFOP 165 page returned 404, so the manual passage could not be read."
        },
        {
          "field": "incomeLimit",
          "reason": "Appendix A-1 also prints a '165% Need Standards' column (2,195 for one person, +781 each additional). It is labeled a need standard, not an income limit, and the chart does not say which households use it, so it is left out of the tables."
        },
        {
          "field": "netIncomeLimit",
          "reason": "Appendix A-1 does not say which households must pass the 100% FPL net test, so the table has no 'when'."
        }
      ]
    },
    "medicaid": {
      "state": "FL",
      "program": "medicaid",
      "name": {
        "value": "Florida Medicaid",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "the state agency responsible for administering the Florida Medicaid program"
      },
      "agency": {
        "value": "Agency for Health Care Administration (AHCA) administers Florida Medicaid; the Department of Children and Families (DCF) determines eligibility",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Medicaid services in Florida are administered by the Agency for Health Care Administration."
      },
      "covers": {
        "value": "Medical coverage for low-income people and families, with costs shared by the state and federal government.",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Medicaid provides medical coverage to low-income individuals and families."
      },
      "incomeLimit": {
        "value": {
          "year": "Appendix A-7, updated 02/02/2026 (this column's effective date is April 1992)",
          "basis": "Family-Related Medicaid limit for parents and other caretaker relatives of a dependent child (the same column covers children 19 and 20); Florida's chart has no full-coverage group for adults 19 to 64 without children unless pregnant, aged or disabled, and adults over the limit may get Medically Needy coverage with a share of cost. Income is counted by expected tax filing status after allowable tax deductions (DCF fact sheet), and the table includes neither disregard: the chart prints a separate standard disregard for this group (109, 146, 183, 221, 258, 296, 333, 371 for sizes 1 to 8, up to 978 for 24), its MNIL note gives this limit plus the standard disregard as the combined figure (289 for one person), and a 5% MAGI disregard (67 for one person) is used only if it makes a failing person pass.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "Parents and other caretaker relatives living with a dependent child (adults 19 to 64 without children have no full-coverage group on this chart)",
              "bySize": [
                180,
                241,
                303,
                364,
                426,
                487,
                549,
                610,
                671,
                733,
                795,
                857,
                919,
                981,
                1043,
                1105,
                1167,
                1229,
                1291,
                1353,
                1415,
                1477,
                1539,
                1601
              ],
              "eachAdditional": 62
            }
          ]
        },
        "sourceUrl": "https://ffic.myflfamilies.com/manual/essfiles/30446.pdf",
        "checkedAt": "2026-10-30",
        "quote": "MNIL--The Medically Needy Income Limit (MNIL) includes the appropriate standard disregard."
      },
      "renewal": {
        "value": "Coverage is approved for 12 months at a time and must be renewed every year through MyACCESS or DCF; changes that affect eligibility must be reported within 10 days.",
        "sourceUrl": "https://www.myflfamilies.com/documents/Family-Related%20Medicaid%20Program%20Fact%20Sheet%20(October%202025).pdf",
        "checkedAt": "2026-10-30",
        "quote": "Medicaid coverage is authorized for 12 months at a time. To continue receiving coverage, a renewal must be completed annually."
      },
      "apply": {
        "value": "Apply or renew online through MyACCESS, at a DCF community partner or customer service center, by mailing a paper application to the ACCESS Central Mail Center in Ocala, or by phone through the Customer Contact Center.",
        "sourceUrl": "https://www.myflfamilies.com/services/public-assistance/economic-self-sufficiency-frequently-asked-questions/",
        "checkedAt": "2026-10-30",
        "quote": "The quickest way is from any computer with an internet connection at: https://www.myaccess.myflfamilies.com"
      },
      "phone": {
        "value": "850-300-4323",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Customer Contact Center (850)300-4323"
      },
      "website": {
        "value": "https://myaccess.myflfamilies.com/",
        "sourceUrl": "https://www.myflfamilies.com/medicaid",
        "checkedAt": "2026-10-30",
        "quote": "renew as quickly as possible by going to https://myaccess.myflfamilies.com to update your Medicaid information"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "No official page fetched states a limit for adults 19 to 64 without children; DCF's Medicaid page and the Family-Related Medicaid fact sheet list no such coverage group. No fetched page states in words that Florida did not expand Medicaid. Appendix A-7 does not use the word MAGI for the limit itself; measuredOn magi rests on its 5% MAGI disregard column and the fact sheet's tax filing rules. The chart does not say in words whether the standard disregard is subtracted from income or added to the limit."
        }
      ]
    },
    "liheap": {
      "state": "FL",
      "program": "liheap",
      "name": {
        "value": "Low-Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "The Low-Income Home Energy Assistance Program (LIHEAP) is a federally funded program"
      },
      "agency": {
        "value": "FloridaCommerce, through local community action agencies",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "FloridaCommerce administers LIHEAP and allocates funding directly to a network of community action agencies"
      },
      "covers": {
        "value": "Help with home heating and cooling bills, paid by the local provider directly to the utility; gas or propane only in winter when it is the main heat source; not water, sewer or telephone.",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "helps income-qualified families with home heating and cooling costs"
      },
      "incomeLimit": {
        "value": {
          "year": "Not stated on the page; current FloridaCommerce LIHEAP page as fetched 2026-10-30",
          "basis": "Total household income no more than 60% of Florida State Median Income or 150% of the federal poverty level; the page lists maximum annual income for households of 1 to 8.",
          "period": "annual",
          "measuredOn": "unstated",
          "tables": [
            {
              "appliesTo": "All households",
              "bySize": [
                32155,
                42049,
                51943,
                61837,
                71730,
                81624,
                83479,
                85335
              ],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "You may qualify for help if your total household income does not exceed the household income limits listed below."
      },
      "renewal": {
        "value": "No fixed renewal cycle: each request is a new application, and depending on county funds a household may get help several times a year, but not every month.",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "Depending on the funds available in your county, you may be able to apply for assistance multiple times a year, but not every month."
      },
      "apply": {
        "value": "Apply through the local LIHEAP agency for your county, online where that agency offers it or by calling the agency; bring a recent energy bill, any termination notice, proof of income, photo ID and Social Security numbers.",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program/find-your-local-low-income-home-energy-assistance-program-provider-for-help",
        "checkedAt": "2026-10-30",
        "quote": "you may apply online below or inquire about assistance through the local agency that serves the county in which you live"
      },
      "website": {
        "value": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program/find-your-local-low-income-home-energy-assistance-program-provider-for-help",
        "sourceUrl": "https://floridajobs.org/community-development/Low-Income-Home-Energy-Assistance-Program",
        "checkedAt": "2026-10-30",
        "quote": "Find Your Local Low-Income Home Energy Assistance Program Provider For Help"
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "The FloridaCommerce LIHEAP page has no statewide application line; it tells residents to call their local county provider. The ACF contact listing prints 850-717-8450 as public inquiries for the state program office, which is an administrator line, not an application line, so it is not recorded."
        },
        {
          "field": "incomeLimit.measuredOn",
          "reason": "The FloridaCommerce page says 'total household income' and asks for proof of current gross income, but does not say the limit is measured on gross income. The page's linked LIHEAP DRAFT State Plan FFY 2027 (a separate, watermarked draft PDF) checks Gross Income at question 1.8; kept as unstated because the fact's source page does not say it."
        },
        {
          "field": "incomeLimit.year",
          "reason": "The FloridaCommerce page gives the annual table without a program year; the only plan linked is a draft for FFY 2027 and it does not print these dollar amounts."
        },
        {
          "field": "incomeLimit.eachAdditional",
          "reason": "The page lists sizes 1 to 8 only and gives no amount for each additional person."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "myflfamilies.com",
      "sourceUrl": "https://www.fna.usda.gov/snap-directory-entry/florida",
      "checkedAt": "2026-10-30",
      "quote": "State SNAP Information State SNAP Website"
    },
    {
      "host": "floridajobs.org",
      "sourceUrl": "https://acf.gov/ocs/data/map/liheap-map-state-and-territory-contact-listing",
      "checkedAt": "2026-10-30",
      "quote": "WEB SITE: www.floridajobs.org/community-planning-and-development/community-services/low-income-home-energy-assistance-program"
    }
  ]
};
