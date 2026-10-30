import type { StateCatalog } from "../types.js";

export const IL: StateCatalog = {
  "state": "IL",
  "programs": {
    "snap": {
      "state": "IL",
      "program": "snap",
      "name": {
        "value": "Supplemental Nutrition Assistance Program (SNAP)",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "The Supplemental Nutrition Assistance Program (SNAP) (formerly Food Stamps) helps low-income people and families"
      },
      "agency": {
        "value": "Illinois Department of Human Services (IDHS)",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "The Department of Human Services administers the program in Illinois."
      },
      "covers": {
        "value": "Monthly benefits on the Illinois Link Card to buy food and seeds or plants for growing food; not hot ready-to-eat food, vitamins, medicine, pet food, alcohol, tobacco or other nonfood items.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "Benefits are provided on the Illinois Link Card - an electronic card that is accepted at most grocery stores."
      },
      "incomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "165% of the federal poverty level, Illinois broad-based categorical eligibility, for households without a qualifying member. Households with a qualifying member (a person who is 60 or older, blind or disabled) use the 200% FPL limit instead: 2660, 3607, 4554, 5500, 6447, 7394, 8340, 9287 for sizes 1 to 8, plus 947 for each additional person.",
          "period": "monthly",
          "bySize": [
            2195,
            2976,
            3757,
            4538,
            5319,
            6100,
            6881,
            7662
          ],
          "eachAdditional": 781
        },
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=180098",
        "checkedAt": "2026-10-30",
        "quote": "Federal law provides for an increase to the Maximum Monthly Gross (165% FPL) and Net Income Standards (100% FPL) effective with October 2026 issuances."
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "100% of the federal poverty level. Per IDHS PM 13-01-01, a household with a qualifying member (blind, 60 or older, or disabled) whose gross income is over the 200% limit can still qualify by meeting this net limit, and households with a member disqualified for an intentional program violation or sanctioned under a work rule must meet both the gross and net limits.",
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
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=180098",
        "checkedAt": "2026-10-30",
        "quote": "Federal law provides for an increase to the Maximum Monthly Gross (165% FPL) and Net Income Standards (100% FPL) effective with October 2026 issuances."
      },
      "renewal": {
        "value": "Most households renew every 6 months, with an interview at alternating renewals and a no-interview EZ REDE form in between; households in the elderly and disabled simplified project (every adult 60 or older or disabled, no earned income) renew every 24 months. IDHS mails the renewal form 60 days before the period ends.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=174483",
        "checkedAt": "2026-10-30",
        "quote": "All SNAP households, except those receiving SNAP under the Elderly and/or Disabled Simplified Redetermination Project (EDSRP), will be assigned 6-month certification periods."
      },
      "apply": {
        "value": "Apply online through ABE (Application for Benefits Eligibility) at abe.illinois.gov, by phone through the ABE Help Line at 1-800-843-6154, in person at a local IDHS Family Community Resource Center, or by carrying, mailing or faxing the paper application IL444-2378 B to that office. An interview follows, in person or by phone.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33698",
        "checkedAt": "2026-10-30",
        "quote": "Use the Application for Benefits Eligibility (ABE) to apply for SNAP, cash or medical assistance - online, anytime."
      },
      "phone": {
        "value": "1-800-843-6154",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33698",
        "checkedAt": "2026-10-30",
        "quote": "Please call our toll-free line ABE Help Line at 1-800-843-6154 (Voice)"
      },
      "website": {
        "value": "https://abe.illinois.gov",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33412",
        "checkedAt": "2026-10-30",
        "quote": "Apply on-line at: www.abe.illinois.gov"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The main IDHS SNAP page (item=30357) and the DHS 124 brochure (item=33412) still show the October 2025 limits (for example $2,152 for one person). The FY2027 numbers here come from IDHS Manual Release 26.26, effective October 2026 issuances, which matches WAG 13-01-01-a."
        }
      ]
    },
    "medicaid": {
      "state": "IL",
      "program": "medicaid",
      "name": {
        "value": "Illinois Medicaid",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/apply.html",
        "checkedAt": "2026-10-30",
        "quote": "Eligibility for Illinois Medicaid is generally based on income, household size, and other factors."
      },
      "agency": {
        "value": "Illinois Department of Healthcare and Family Services (HFS)",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicalprograms.html",
        "checkedAt": "2026-10-30",
        "quote": "The Illinois Department of Healthcare and Family Services (HFS) is committed to improving the health of Illinois' families by providing access to quality healthcare."
      },
      "covers": {
        "value": "Health coverage that for most enrollees includes doctor visits, dental care, well-child care and immunizations, mental health and substance use services, hospital and emergency care, prescription drugs, and medical equipment and supplies; some programs cover a limited set of services.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicalprograms.html",
        "checkedAt": "2026-10-30",
        "quote": "Most people who enroll are covered for comprehensive services, including, but not limited to; doctor visits and dental care, well-child care, immunizations for children"
      },
      "incomeLimit": {
        "value": {
          "year": "2026 (IDHS chart Program Standards 2026, WAG 25-03-02 (2))",
          "basis": "ACA Adults (adults 19 to 64 under the Medicaid expansion) and FamilyCare parents and caretaker relatives: 138% of the federal poverty level, including the 5% disregard, MAGI income",
          "period": "monthly",
          "bySize": [
            1835,
            2488,
            3141,
            3795,
            4448,
            5101,
            5754,
            6407
          ],
          "eachAdditional": 652
        },
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=21741",
        "checkedAt": "2026-10-30",
        "quote": "FamilyCare and ACA Adults MAGI - 138% FPL (includes 5% disregard) (Adults)"
      },
      "renewal": {
        "value": "Coverage is renewed every 12 months today; HFS mails a renewal letter and coverage ends if you do not respond. Starting with their first renewal in 2027, some ACA Adults will renew every 6 months and must meet or be exempt from new federal work requirements.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/hr1customernotices.html",
        "checkedAt": "2026-10-30",
        "quote": "will need to redetermine their eligibility every 6 months, instead of every 12 months as it is now."
      },
      "apply": {
        "value": "Apply online at abe.illinois.gov (the same application covers SNAP and cash), by phone through the DHS Help Line at 1-800-843-6154, in person at an IDHS Family Community Resource Center, or by carrying, mailing or faxing a paper application to that office.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "There are four ways to apply for Medicaid:"
      },
      "phone": {
        "value": "1-800-843-6154",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "You can apply over the phone by calling the DHS Help Line at 1-800-843-6154."
      },
      "website": {
        "value": "https://abe.illinois.gov",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "You can apply online at https://abe.illinois.gov"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The HFS Medical Programs page still prints an older ACA Adults figure ($1,366 per individual, $1,845 per couple). The numbers here come from the IDHS chart that the HFS Medicaid guide links as Medicaid Program Income Standards; that chart is labeled 2026 and does not state an end date."
        },
        {
          "field": "phone",
          "reason": "The number given is the DHS Help Line for applying. HFS also lists a Health Benefits Hotline (1-866-468-7543 in Illinois) for questions about medical benefits and a renewal line (1-866-255-5437) on its HealthChoice renewal page."
        }
      ]
    },
    "liheap": {
      "state": "IL",
      "program": "liheap",
      "name": {
        "value": "Low Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "The Low Income Home Energy Assistance Program (LIHEAP) helps eligible low-income households pay for home energy services (primarily heating during winter months)."
      },
      "agency": {
        "value": "Illinois Department of Commerce and Economic Opportunity (DCEO), Office of Community Assistance, through local administering agencies in each county",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "checkedAt": "2026-10-30",
        "quote": "Help Illinois Families is administered by DCEO’s Office of Community Assistance for the following federal programs: Low-Income Home Energy Assistance Program (LIHEAP)"
      },
      "covers": {
        "value": "Help paying home energy bills, mainly heating in winter: a one-time payment to the gas, electric or propane vendor (or a cash benefit for renters whose heat is in the rent), plus crisis help such as reconnection assistance while funds last.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "helps eligible low-income households pay for home energy services (primarily heating during winter months)."
      },
      "incomeLimit": {
        "value": {
          "year": "Program Year 2027 (applications Oct 1, 2026 to Aug 13, 2027), based on 2026 federal poverty guidelines",
          "basis": "300% of the federal poverty guidelines, gross income for the 30 days before applying, for customers of Ameren Illinois, ComEd, Nicor Gas, North Shore Gas and Peoples Gas. Customers of other energy vendors must be at or below 60% of state median income, which DCEO does not list in dollars on this page.",
          "period": "monthly",
          "bySize": [
            3990,
            5410,
            6830,
            8250,
            9670,
            11090,
            12510,
            13930
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
        "checkedAt": "2026-10-30",
        "quote": "2026 300% Federal Poverty Guidelines for 2027 Program Year"
      },
      "renewal": {
        "value": "No automatic renewal: LIHEAP pays a one-time benefit per program year, so a household applies again each program year; the 2027 program year takes applications from October 1, 2026 to August 13, 2027 or until funds run out.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/faqs.html",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP provides a one-time benefit per Program Year to eligible customers."
      },
      "apply": {
        "value": "Submit the online Request for Services form at helpillinoisfamilies.com during your application month and wait for your county's local agency to contact you, or apply directly with the local agency. Adults 60 and older, people with disabilities, families with a child 5 or under and households facing disconnection could apply from October 1, 2026; everyone else from November 1, 2026.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
        "checkedAt": "2026-10-30",
        "quote": "Please visit helpillinoisfamilies.com during your application month to fill out and submit an online Request for Services form."
      },
      "phone": {
        "value": "1-833-711-0374",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "Or call Help Illinois Families call center at 1-833-711-0374."
      },
      "website": {
        "value": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "checkedAt": "2026-10-30",
        "quote": "The Help Illinois Families’ online Request for Services form makes it easier to request information for assistance through the LIHEAP and/or CSBG programs."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "DCEO publishes dollar limits only for the 300% FPL utility-customer group (sizes 1 to 8, no per-person add-on). The 60% state median income limit for customers of other vendors is stated as a rule but no dollar table was found on the How to Apply page or in the FY27 LIHEAP state plan PDF."
        },
        {
          "field": "website",
          "reason": "https://helpillinoisfamilies.com and https://www.helpillinoisfamilies.com refused HTTPS connections when checked; http://helpillinoisfamilies.com redirected to the DCEO Help Illinois Families page used here, which links the Request for Services form."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "dhs.state.il.us",
      "sourceUrl": "https://www.illinois.gov/agencies/agency.dhs.html",
      "checkedAt": "2026-10-30",
      "quote": "Illinois created DHS in 1997, to provide our state's residents with streamlined access to integrated services"
    },
    {
      "host": "helpillinoisfamilies.com",
      "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
      "checkedAt": "2026-10-30",
      "quote": "Please visit helpillinoisfamilies.com during your application month to fill out and submit an online Request for Services form."
    }
  ]
};
