import type { StateCatalog } from "../types.js";

export const AZ: StateCatalog = {
  "state": "AZ",
  "programs": {
    "snap": {
      "state": "AZ",
      "program": "snap",
      "name": {
        "value": "Nutrition Assistance",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na",
        "checkedAt": "2026-10-30",
        "quote": "Nutrition Assistance (formerly the Food Stamp Program)"
      },
      "agency": {
        "value": "Arizona Department of Economic Security (DES), Family Assistance Administration",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na/how-apply-nutrition-assistance",
        "checkedAt": "2026-10-30",
        "quote": "the DES Family Assistance Administration has offices statewide to assist you with the application process"
      },
      "covers": {
        "value": "Monthly benefits that eligible households use to buy food.",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na",
        "checkedAt": "2026-10-30",
        "quote": "Nutrition Assistance gives eligible households monthly benefits to buy nutritious food."
      },
      "incomeLimit": {
        "value": {
          "year": "Effective 10/01/2026",
          "basis": "DES Nutrition Assistance policy: a budgetary unit is expanded categorically eligible when gross income does not exceed 200% of the current federal poverty level, and is then treated as meeting the gross and net income tests. Units that are not categorically eligible face the 130% FPL gross income standard, which DES publishes on a separate policy page; units with a member 60 or older or with a disability are not subject to that gross standard.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "expanded categorically eligible households (200% of the federal poverty level); this is the gross limit most households are screened against",
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
              "appliesTo": "households that are not categorically eligible and have no member 60 or older or with a disability (130% of the federal poverty level); the state sets 130% of the federal poverty level for them, and the amounts are the federal FY2027 130% table",
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
        "sourceUrl": "https://dbmefaapolicy.azdes.gov/FAA6/NA_200__of_the_Federal_Poverty_Level.html",
        "checkedAt": "2026-10-30",
        "quote": "Effective 03/01/2026, the maximum gross monthly income of categorically eligible NA budgetary units."
      },
      "netIncomeLimit": {
        "value": {
          "year": "Effective 10/01/2026",
          "basis": "100% of the federal poverty level. DES policy treats expanded categorically eligible households as meeting the net income test, so this limit decides eligibility for households that are not categorically eligible, including households with a member 60 or older or with a disability whose gross income is over 200% FPL; basic categorically eligible households are compared against it to calculate benefits.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "all households whose eligibility depends on the net income test",
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
        "sourceUrl": "https://dbmefaapolicy.azdes.gov/FAA6/NA_Net_Monthly_Income_Eligibility_Standard_(.html",
        "checkedAt": "2026-10-30",
        "quote": "Net Monthly Income Eligibility Standard (100% of the Federal Poverty Level)"
      },
      "renewal": {
        "value": "Benefits must be renewed at the end of each certification period, which can range from three months to two years; DES mails a letter when it is time to renew.",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na/how-apply-nutrition-assistance",
        "checkedAt": "2026-10-30",
        "quote": "Renewal dates can range from three months to two years from the initial application date."
      },
      "apply": {
        "value": "Apply online through Health-e-Arizona Plus, by mail or fax with a paper application (call 1-855-432-7587 to have one mailed), in person at a DES office, or with a community assistor; an eligibility interview is required.",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na/how-apply-nutrition-assistance",
        "checkedAt": "2026-10-30",
        "quote": "The easiest way to apply for benefits is online through Health-e-Arizona Plus."
      },
      "phone": {
        "value": "1-855-432-7587",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na/how-apply-nutrition-assistance",
        "checkedAt": "2026-10-30",
        "quote": "Request an application to be mailed to you by calling 1-855-432-7587."
      },
      "website": {
        "value": "https://www.healthearizonaplus.gov/",
        "sourceUrl": "https://des.az.gov/services/basic-needs/food-assistance/nutrition-assistance-na",
        "checkedAt": "2026-10-30",
        "quote": "Ready to apply? Get started through Health-e-Arizona Plus"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "Each DES income standard is on its own policy page, so the 130% FPL table (1729, 2345, 2960, 3575, 4191, 4806, 5421, 6037; each additional 616, effective 10/01/2026) is not on the 200% page and is left as bySize []. The 165% FPL Elderly or Disability standard is not a household limit: DES applies it to separate budgetary units living with an elderly or disabled member who cannot buy and cook food alone, so it is left out. Households with a member 60 or older or disabled are not subject to the gross standard and can qualify above 200% FPL on the net test, which the table shape cannot express. dbmefaapolicy.azdes.gov returns 403 to curl, so a curl quote check will fail; the text was read in a browser."
        },
        {
          "field": "netIncomeLimit",
          "reason": "dbmefaapolicy.azdes.gov returns 403 to curl, so a curl quote check will fail; the quote was read in a browser."
        }
      ]
    },
    "medicaid": {
      "state": "AZ",
      "program": "medicaid",
      "name": {
        "value": "AHCCCS",
        "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/adults.html",
        "checkedAt": "2026-10-30",
        "quote": "AHCCCS offers health insurance for adults age 19 to 64"
      },
      "agency": {
        "value": "Arizona Health Care Cost Containment System (AHCCCS); applications for most adults and families are processed by the Arizona Department of Economic Security (DES)",
        "sourceUrl": "https://www.azahcccs.gov/",
        "checkedAt": "2026-10-30",
        "quote": "Arizona Health Care Cost Containment System (AHCCCS) is Arizona's Medicaid agency that offers health care programs to serve Arizona residents."
      },
      "covers": {
        "value": "Health insurance (Medicaid) for Arizona residents who meet income and other requirements.",
        "sourceUrl": "https://www.azahcccs.gov/",
        "checkedAt": "2026-10-30",
        "quote": "Arizona Health Care Cost Containment System (AHCCCS) is Arizona's Medicaid agency that offers health care programs to serve Arizona residents."
      },
      "incomeLimit": {
        "value": {
          "year": "Effective 02/01/2026",
          "basis": "AHCCCS publishes a gross monthly limit for each coverage category on its own page, all effective 02/01/2026. The screen does not ask age, disability, pregnancy or whether someone cares for a child, so it compares income with the lowest limit among these categories.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "adults 19 to 64 in the AHCCCS Adult Group",
              "bySize": [
                1769,
                2399,
                3028,
                3658,
                4288
              ],
              "eachAdditional": null
            },
            {
              "appliesTo": "people 65 or older (the applicant, or the applicant and spouse)",
              "bySize": [
                1330,
                1804
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/elderly.html",
                "checkedAt": "2026-10-30",
                "quote": "This chart shows how much money the person can receive each month (gross monthly income) before taxes and other deductions are subtracted."
              }
            },
            {
              "appliesTo": "people who are blind or have a disability (the applicant, or the applicant and spouse)",
              "bySize": [
                1330,
                1804
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/disabled.html",
                "checkedAt": "2026-10-30",
                "quote": "If your monthly income is higher than the limit listed below, you may be eligible for the new adult category."
              }
            },
            {
              "appliesTo": "parents and caretaker relatives living with a child (the page marks its each-additional amount as approximate, so it is not used)",
              "bySize": [
                1410,
                1912,
                2414,
                2915,
                3417
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/families.html",
                "checkedAt": "2026-10-30",
                "quote": "A person may be able to qualify even if the person is not the parent of the child, if the person is related to and taking care of the child."
              }
            },
            {
              "appliesTo": "children age 6 through 18",
              "bySize": [
                1769,
                2399,
                3028,
                3658,
                4288
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/children.html",
                "checkedAt": "2026-10-30",
                "quote": "Monthly Income Limit (Age 6 through 18)"
              }
            },
            {
              "appliesTo": "children age 1 through 5",
              "bySize": [
                1876,
                2543,
                3211,
                3878,
                4545
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/children.html",
                "checkedAt": "2026-10-30",
                "quote": "Monthly Income Limit (Age 1 through 5)"
              }
            },
            {
              "appliesTo": "children under age 1",
              "bySize": [
                1956,
                2651,
                3347,
                4043,
                4739
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/children.html",
                "checkedAt": "2026-10-30",
                "quote": "Monthly Income Limit (Under age 1)"
              }
            },
            {
              "appliesTo": "pregnant people",
              "bySize": [
                2075,
                2814,
                3552,
                4290,
                5029
              ],
              "eachAdditional": null,
              "source": {
                "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/pregnant.html",
                "checkedAt": "2026-10-30",
                "quote": "This chart shows how much money the applicant can receive each month before taxes (gross monthly income) and other deductions are subtracted."
              }
            }
          ]
        },
        "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/Categories/adults.html",
        "checkedAt": "2026-10-30",
        "quote": "Gross Monthly Income Limit Effective 02/01/2026"
      },
      "renewal": {
        "value": "Coverage is renewed every 12 months today; starting January 1, 2027, most people in the adult group (ages 19 to 64) will renew every 6 months, except American Indians and Alaska Natives, and anyone who renews in 2026 stays on a 12-month renewal until their 2027 renewal.",
        "sourceUrl": "https://keepmyahcccs.com/",
        "checkedAt": "2026-10-30",
        "quote": "Starting January 1, 2027, most individuals in the adult group will renew their AHCCCS coverage every 6 months. This replaces the yearly renewal."
      },
      "apply": {
        "value": "Apply or renew online through Health-e-Arizona Plus, get help from a community assistor, or print a DES Application for Benefits (or form DE-103 if 65 or older, blind or disabled) and send it in.",
        "sourceUrl": "https://www.azahcccs.gov/Members/GetCovered/apply.html",
        "checkedAt": "2026-10-30",
        "quote": "You can apply online for AHCCCS Medical Assistance, Nutrition Assistance, and Cash Assistance using Health-e-Arizona Plus (HEAplus)."
      },
      "phone": {
        "value": "1-855-432-7587",
        "sourceUrl": "https://www.azahcccs.gov/Members/AlreadyCovered/EligibilityInformation.html",
        "checkedAt": "2026-10-30",
        "quote": "DES www.healthearizonaplus.gov or 1(855)HEA-PLUS (1-855-432-7587)"
      },
      "website": {
        "value": "https://www.healthearizonaplus.gov/",
        "sourceUrl": "https://www.azahcccs.gov/Members/AlreadyCovered/EligibilityInformation.html",
        "checkedAt": "2026-10-30",
        "quote": "create one today on Health-e-Arizona Plus at www.healthearizonaplus.gov"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The page lists household sizes 1 to 5 only and marks its $630 each-additional amount as approximate, so eachAdditional is null and sizes 6 and up have no limit. The page does not say whether the limit is MAGI-based or includes a 5% disregard; measuredOn follows its own label, gross."
        },
        {
          "field": "incomeLimit.tables",
          "reason": "The 65 or older and the blind or disabled categories list only the applicant and the applicant and spouse, so no limit is published for larger household sizes there; ALTCS and the Medicare Savings Programs are not included. Each-additional amounts on these pages are marked approximate and are not used."
        }
      ]
    },
    "liheap": {
      "state": "AZ",
      "program": "liheap",
      "name": {
        "value": "Low Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "The Low Income Home Energy Assistance Program (LIHEAP) is a federally funded program"
      },
      "agency": {
        "value": "Arizona Department of Economic Security (DES), with local Community Action Agencies helping applicants",
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "Arizona Department of Economic Security"
      },
      "covers": {
        "value": "Help paying heating and cooling bills, plus crisis help for households facing a shut-off after their regular benefit is used up.",
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "helps low income households pay their heating/cooling bills, minimize energy-related crises, and make energy costs more affordable"
      },
      "incomeLimit": {
        "value": {
          "year": "Not dated on the page; the page says its information is effective for applications received on or after October 12, 2024",
          "basis": "DES LIHEAP Maximum Household Income table of monthly gross income limits. Households where a member receives DES Nutrition Assistance or Cash Assistance are categorically eligible and treated as meeting the income requirement.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "all households applying for LIHEAP",
              "bySize": [
                2936,
                3840,
                4743,
                5647,
                6550,
                7454,
                7623,
                7793,
                7962,
                8385,
                9095,
                9805
              ],
              "eachAdditional": 710
            }
          ]
        },
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP Maximum Household Income"
      },
      "renewal": {
        "value": "There is no automatic renewal; a household can get one regular LIHEAP benefit and one crisis benefit in each 12-month period and must apply again after that, and help is first come, first served while funds last.",
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP eligibility is limited to once in a 12-month period for a Regular LIHEAP benefit and once in a 12-month period for a Crisis LIHEAP benefit."
      },
      "apply": {
        "value": "Apply online in the A-to-Z Arizona Portal, or use a paper application sent by fax or mail; local Community Action Agencies and the LIHEAP service line help with applications.",
        "sourceUrl": "https://des.az.gov/services/basic-needs/shelter-housing/utility-assistance/liheap-faqs",
        "checkedAt": "2026-10-30",
        "quote": "Applications should be initiated and completed through the A-to-Z Arizona Portal."
      },
      "phone": {
        "value": "1-866-494-1981",
        "sourceUrl": "https://des.az.gov/services/basic-needs/shelter-housing/utility-assistance/liheap-faqs",
        "checkedAt": "2026-10-30",
        "quote": "You can also call the LIHEAP service line at 1-866-494-1981."
      },
      "website": {
        "value": "https://desportal.az.gov/",
        "sourceUrl": "https://des.az.gov/liheap",
        "checkedAt": "2026-10-30",
        "quote": "Applicants can apply for LIHEAP by using the A-to-Z Arizona Portal."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The page does not date its income table, and the posted LIHEAP State Plan PDF was not read this pass (des.az.gov returns 403 to curl), so the percent of state median income or poverty guideline behind each row is not stated here. des.az.gov also blocks curl, so a curl quote check will fail; the text was read in a browser."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "keepmyahcccs.com",
      "sourceUrl": "https://www.azahcccs.gov/",
      "checkedAt": "2026-10-30",
      "quote": "Changes Are Coming to AHCCCS: What You Need to Know About Work Requirements and 6-Month Renewals"
    }
  ]
};
