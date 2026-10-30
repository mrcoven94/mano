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
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "200% of the federal poverty level, expanded categorical eligibility (broad-based). Households that are not categorically eligible face the federal 130% FPL gross limit (1729, 2345, 2960, 3575, 4191, 4806, 5421, 6037; each additional 616), published on the DES policy page FAA6/NA_Gross_Monthly_Income_Eligibility_Standard.html.",
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
        "sourceUrl": "https://dbmefaapolicy.azdes.gov/FAA6/NA_200__of_the_Federal_Poverty_Level.html",
        "checkedAt": "2026-10-30",
        "quote": "Effective 03/01/2026, the maximum gross monthly income of categorically eligible NA budgetary units."
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "100% of the federal poverty level. DES policy says expanded categorically eligible households are treated as meeting the gross and net income tests, so this limit applies to households that are not expanded categorically eligible; basic categorically eligible households are compared against it to calculate benefits.",
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
      "gaps": []
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
          "basis": "AHCCCS Adult Group (Medicaid expansion), adults 19 to 64 who do not qualify for another AHCCCS group, not pregnant and not on Medicare. The page lists sizes 1 to 5 only; its each-additional amount of $630 is marked as approximate, so it is not used here.",
          "period": "monthly",
          "bySize": [
            1769,
            2399,
            3028,
            3658,
            4288
          ],
          "eachAdditional": null
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
          "reason": "The AHCCCS adults page lists household sizes 1 to 5 only, so sizes 6 to 8 are not given; the $630 each-additional figure is labeled approximate on the page. The page does not state the percent of the federal poverty level."
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
          "year": "Current DES LIHEAP table; the page does not date it. The posted LIHEAP State Plan covers 10/01/2025 to 09/30/2026.",
          "basis": "Monthly gross household income. The LIHEAP State Plan sets 60% of state median income for household sizes 1 to 9 and 150% of HHS poverty guidelines for 10 or more. The page also lists sizes 9 to 12 (7962, 8385, 9095, 9805) and $710 for each person over 12. Households on DES Nutrition Assistance or Cash Assistance are categorically eligible.",
          "period": "monthly",
          "bySize": [
            2936,
            3840,
            4743,
            5647,
            6550,
            7454,
            7623,
            7793
          ],
          "eachAdditional": null
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
          "reason": "The DES LIHEAP page does not say which program year its income table is for, and the only State Plan posted covers FFY2026 (10/01/2025 to 09/30/2026); no FFY2027 table or plan was found on des.az.gov."
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
